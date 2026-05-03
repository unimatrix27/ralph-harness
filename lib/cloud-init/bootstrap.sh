# shellcheck shell=bash
#
# cloud-init/bootstrap.sh — slice 6 cloud-init payload. Runs once on the
# EC2 worker's first (and only) boot. Does the work needed to reach a
# state where a `claude` call would succeed against the target repo,
# then hands off to `orch::run`:
#
#   1. resolve instance metadata via IMDSv2
#   2. install + start the amazon-cloudwatch-agent so /var/log/ralph.log
#      streams live to CloudWatch (every ~5s) — survives force-termination
#      because we no longer depend on a clean shutdown to ship logs.
#      Wire the EXIT trap so any script exit triggers OS shutdown; the
#      launcher set --instance-initiated-shutdown-behavior=terminate so
#      OS shutdown is EC2 termination
#   3. install OS deps: Node 20, .NET 10 SDK (via dotnet-install.sh), gh
#      CLI, Docker, uv, claude CLI, plus jq, git, yq for the harness
#      itself
#   4. fetch the GitHub PAT and the Claude OAuth credential from SSM
#      SecureString (decrypt under alias/ralph). Both land in their
#      consumer's expected on-disk location with mode 0600 and are
#      never echoed
#   5. clone the target repo fresh into a per-run working directory on
#      its resolved default branch (no main/master assumption)
#   6. run safety guards: on default branch (we just cloned), no
#      uncommitted state, origin matches RALPH_TARGET_REPO
#   7. configure claude MCPs: serena, morph-mcp, context7, github,
#      sequential-thinking. The `memory` MCP is intentionally NOT added
#      — clean-context-per-iteration is a hard contract
#   8. validate the target's .ralph/config.yaml via `tcs::validate`
#      (sourced from target-config-schema.sh); fail loud and exit
#      non-zero on any error
#   9. hand off to `orch::run` (sourced from ec2-orchestrator.sh)
#
# Inputs (env, set by fire-launcher's render header):
#   RALPH_TARGET_REPO            required, owner/repo
#   RALPH_AWS_REGION             required, e.g. eu-central-1
#   RALPH_GITHUB_TOKEN_SSM_KEY   SSM SecureString name for the GitHub PAT
#   RALPH_CLAUDE_OAUTH_SSM_KEY   SSM SecureString name for the OAuth cred
#   RALPH_LOG_GROUP              CloudWatch log group
#
# This file is concatenated into the rendered user-data after
# target-config-schema.sh and ec2-orchestrator.sh, so `tcs::validate`
# and `orch::run` are already defined when control reaches `boot__main`.

set -uo pipefail

# cloud-init runs user-data as root via systemd with no HOME env. Under
# `set -u` every ${HOME} reference would trip "unbound variable" and abort
# boot__main, so default it before any function uses it.
: "${HOME:=/root}"
export HOME

# claude CLI refuses --permission-mode bypassPermissions / --dangerously-
# skip-permissions when running as root. cloud-init runs user-data as
# root, and the orchestrator's claude invocations need the bypass. The
# throwaway EC2 (scoped IAM, no SSH, ≤75-min lifetime) is the sandbox
# this knob exists for.
export IS_SANDBOX=1

: "${RALPH_LOG_GROUP:=/ralph/main}"
: "${RALPH_GITHUB_TOKEN_SSM_KEY:=/ralph/github-pat}"
: "${RALPH_CLAUDE_OAUTH_SSM_KEY:=/ralph/claude-oauth-credential}"

LOG_FILE="/var/log/ralph.log"
: > "$LOG_FILE"

# ---- IMDSv2 + metadata -------------------------------------------------------

boot__md_token=$(curl -fsS -m 5 -X PUT \
    "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)

boot__md() {
    curl -fsS -m 5 \
        -H "X-aws-ec2-metadata-token: ${boot__md_token}" \
        "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
}

INSTANCE_ID=$(boot__md instance-id)
REGION="${RALPH_AWS_REGION:-$(boot__md placement/region)}"
LOG_STREAM="${INSTANCE_ID:-unknown-instance}"

# Per-launch identifier embedded by the implementation call as an HTML
# comment in the PR body so the launcher can correlate post-hoc when the
# instance was hard-killed before recording state. Defaults to the
# instance id; falls back to a timestamp+pid pair if IMDS is unreachable.
RALPH_LAUNCH_TAG="${INSTANCE_ID:-$(date -u +%s)-$$}"
export RALPH_LAUNCH_TAG

# ---- live log streaming via amazon-cloudwatch-agent + shutdown trap ----------
#
# CloudWatch shipping is done by amazon-cloudwatch-agent tailing the local
# log files (force_flush_interval=5s), not by an end-of-run flush. This
# means logs arrive in CloudWatch within seconds and survive force-
# termination by the launcher's wall-clock backstop (which bypasses the
# EXIT trap entirely). The agent install runs early in boot__main; if it
# fails the run continues without live logs (best-effort, never fatal).

boot__start_cwagent() {
    boot__info "PHASE_START phase=cwagent stream=${LOG_STREAM}"
    if ! dnf -y -q --allowerasing install amazon-cloudwatch-agent >/dev/null 2>&1; then
        boot__err "amazon-cloudwatch-agent install failed; live log streaming disabled"
        return 0
    fi
    local cfg=/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/ralph.json
    install -d -m 755 "$(dirname "$cfg")"
    cat > "$cfg" <<JSON
{
  "agent": { "run_as_user": "root" },
  "logs": {
    "force_flush_interval": 5,
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "${LOG_FILE}",
            "log_group_name": "${RALPH_LOG_GROUP}",
            "log_stream_name": "${LOG_STREAM}",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/cloud-init-output.log",
            "log_group_name": "${RALPH_LOG_GROUP}",
            "log_stream_name": "${LOG_STREAM}-cloud-init",
            "timezone": "UTC"
          }
        ]
      }
    }
  }
}
JSON
    if /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
            -a fetch-config -m ec2 -c "file:${cfg}" -s >/dev/null 2>&1; then
        boot__info "PHASE_END phase=cwagent"
    else
        boot__err "amazon-cloudwatch-agent failed to start; live log streaming disabled"
    fi
}

boot__shutdown_now() {
    /sbin/shutdown -h now 2>/dev/null \
        || /usr/sbin/shutdown -h now 2>/dev/null \
        || shutdown -h now 2>/dev/null \
        || halt -p 2>/dev/null \
        || poweroff
}

trap boot__shutdown_now EXIT

# ---- helpers -----------------------------------------------------------------

boot__info() { printf 'ec2-bootstrap: %s\n' "$*"; }
boot__err()  { printf 'ec2-bootstrap: error: %s\n' "$*" >&2; }

# Pulls a SecureString parameter, decrypts under the role's permitted KMS
# alias, prints the value to stdout. Caller redirects to a 0600 file.
boot__ssm_get() {
    local name="$1"
    aws --region "$REGION" ssm get-parameter \
        --name "$name" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text
}

# ---- install OS deps ---------------------------------------------------------

boot__install_deps() {
    boot__info "PHASE_START phase=install-deps"

    # AL2023 base image ships `curl-minimal`, which already provides
    # /usr/bin/curl. Pulling the full `curl` package triggers a hard
    # transaction conflict, so we don't request it. `--allowerasing`
    # is passed defensively so any later package needing full `curl`
    # can swap curl-minimal out cleanly instead of aborting the install.
    dnf -y -q --allowerasing install dnf-plugins-core git tar gzip python3 jq >/dev/null

    # Node 20 — AL2023 ships the `nodejs20` package directly.
    dnf -y -q --allowerasing install nodejs20 >/dev/null

    # gh CLI — official rpm repo.
    dnf -y -q config-manager --add-repo \
        https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null
    dnf -y -q --allowerasing install gh >/dev/null

    # Docker — required by the github MCP container.
    dnf -y -q --allowerasing install docker >/dev/null
    systemctl enable --now docker >/dev/null 2>&1 || true

    # yq (mikefarah v4) — required by target-config-schema.
    if ! command -v yq >/dev/null 2>&1; then
        local arch yq_bin
        arch="$(uname -m)"
        case "$arch" in
            x86_64)  yq_bin=yq_linux_amd64 ;;
            aarch64) yq_bin=yq_linux_arm64 ;;
            *)       yq_bin=yq_linux_amd64 ;;
        esac
        curl -fsSL \
            "https://github.com/mikefarah/yq/releases/latest/download/${yq_bin}" \
            -o /usr/local/bin/yq
        chmod +x /usr/local/bin/yq
    fi

    # uv (astral) — used by serena.
    if ! command -v uv >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
        export PATH="/root/.local/bin:${HOME}/.local/bin:${PATH}"
    fi

    # .NET 10 SDK via dotnet-install.sh.
    if ! command -v dotnet >/dev/null 2>&1; then
        curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
        chmod +x /tmp/dotnet-install.sh
        /tmp/dotnet-install.sh --channel 10.0 \
            --install-dir /usr/share/dotnet >/dev/null
        ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
        rm -f /tmp/dotnet-install.sh
    fi

    # claude CLI (npm global).
    npm install -g @anthropic-ai/claude-code >/dev/null

    boot__info "PHASE_END phase=install-deps"
}

# ---- fetch secrets from SSM --------------------------------------------------

boot__fetch_secrets() {
    boot__info "PHASE_START phase=fetch-secrets"

    # GitHub PAT — written to a 0600 file, fed into `gh auth login --with-token`
    # via stdin. The PAT is also exported as GH_TOKEN so `git` over HTTPS
    # picks it up (gh's git-credential helper). Never echoed or logged.
    local pat_dir="${HOME}/.ralph"
    install -d -m 700 "$pat_dir"
    local pat_file="${pat_dir}/github-pat"
    if ! boot__ssm_get "$RALPH_GITHUB_TOKEN_SSM_KEY" > "$pat_file"; then
        boot__err "could not fetch GitHub PAT from ${RALPH_GITHUB_TOKEN_SSM_KEY}"
        return 1
    fi
    chmod 600 "$pat_file"
    if ! gh auth login --with-token < "$pat_file" >/dev/null 2>&1; then
        boot__err "gh auth login failed"
        return 1
    fi
    # Register gh's git-credential helper so plain `git clone https://…`
    # against the target (private repo expected) picks up the PAT. Without
    # this, the clone-target phase 404s on private targets.
    if ! gh auth setup-git >/dev/null 2>&1; then
        boot__err "gh auth setup-git failed"
        return 1
    fi
    GH_TOKEN="$(<"$pat_file")"
    GITHUB_PERSONAL_ACCESS_TOKEN="$GH_TOKEN"
    export GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN

    # Claude OAuth credential — landed at the Linux claude CLI's expected
    # path, $HOME/.claude/.credentials.json, mode 0600.
    local cred_dir="${HOME}/.claude"
    install -d -m 700 "$cred_dir"
    local cred_file="${cred_dir}/.credentials.json"
    if ! boot__ssm_get "$RALPH_CLAUDE_OAUTH_SSM_KEY" > "$cred_file"; then
        boot__err "could not fetch OAuth credential from ${RALPH_CLAUDE_OAUTH_SSM_KEY}"
        return 1
    fi
    chmod 600 "$cred_file"

    boot__info "PHASE_END phase=fetch-secrets"
}

# ---- fresh clone of target on resolved default branch ------------------------

boot__clone_target() {
    boot__info "PHASE_START phase=clone-target target=${RALPH_TARGET_REPO}"
    if [[ -z "${RALPH_TARGET_REPO:-}" ]]; then
        boot__err "RALPH_TARGET_REPO is required"
        return 2
    fi
    local default_branch
    default_branch=$(gh repo view "$RALPH_TARGET_REPO" \
        --json defaultBranchRef \
        --jq '.defaultBranchRef.name')
    if [[ -z "$default_branch" ]]; then
        boot__err "could not resolve default branch for ${RALPH_TARGET_REPO}"
        return 1
    fi
    local work_dir
    work_dir="$(mktemp -d -t ralph-work-XXXXXX)"
    if ! git clone --depth 1 --branch "$default_branch" \
            "https://github.com/${RALPH_TARGET_REPO}.git" "$work_dir" \
            >/dev/null 2>&1; then
        boot__err "git clone of ${RALPH_TARGET_REPO} failed"
        return 1
    fi
    RALPH_WORK_DIR="$work_dir"
    RALPH_DEFAULT_BRANCH="$default_branch"
    export RALPH_WORK_DIR RALPH_DEFAULT_BRANCH
    cd "$RALPH_WORK_DIR"
    boot__info "PHASE_END phase=clone-target branch=${default_branch} dir=${RALPH_WORK_DIR}"
}

# ---- safety guards -----------------------------------------------------------

boot__safety_guards() {
    boot__info "PHASE_START phase=safety-guards"
    cd "${RALPH_WORK_DIR:?work dir required}"

    local current_branch
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    # AC: "not on default branch is asserted-false" — i.e. we expect to BE
    # on the default branch immediately after a fresh clone.
    if [[ "$current_branch" != "$RALPH_DEFAULT_BRANCH" ]]; then
        boot__err "post-clone branch is ${current_branch}, expected ${RALPH_DEFAULT_BRANCH}"
        return 1
    fi

    if [[ -n "$(git status --porcelain)" ]]; then
        boot__err "fresh clone has uncommitted state — refusing to continue"
        return 1
    fi

    local origin
    origin=$(git remote get-url origin)
    if [[ "$origin" != *"${RALPH_TARGET_REPO}"* ]]; then
        boot__err "origin (${origin}) does not match RALPH_TARGET_REPO (${RALPH_TARGET_REPO})"
        return 1
    fi

    boot__info "PHASE_END phase=safety-guards"
}

# ---- configure claude MCPs (memory excluded) ---------------------------------

boot__configure_mcps() {
    boot__info "PHASE_START phase=configure-mcps"
    # The MCP set is fixed by the harness. `memory` is intentionally NOT
    # added — clean-context-per-iteration is a hard contract.
    claude mcp add serena -- \
        uvx --from git+https://github.com/oraios/serena serena-mcp-server \
        >/dev/null 2>&1 || true
    claude mcp add morph-mcp -- \
        npx -y @morph-labs/morph-mcp \
        >/dev/null 2>&1 || true
    claude mcp add context7 -- \
        npx -y @upstash/context7-mcp \
        >/dev/null 2>&1 || true
    claude mcp add github -- \
        docker run -i --rm \
            -e GITHUB_PERSONAL_ACCESS_TOKEN \
            ghcr.io/github/github-mcp-server \
        >/dev/null 2>&1 || true
    claude mcp add sequential-thinking -- \
        npx -y @modelcontextprotocol/server-sequential-thinking \
        >/dev/null 2>&1 || true
    boot__info "PHASE_END phase=configure-mcps"
}

# ---- validate target config --------------------------------------------------

boot__load_config() {
    boot__info "PHASE_START phase=load-config"
    local cfg="${RALPH_WORK_DIR}/.ralph/config.yaml"
    if [[ ! -f "$cfg" ]]; then
        boot__err "${RALPH_TARGET_REPO} is missing .ralph/config.yaml — refusing to continue"
        return 2
    fi
    if ! tcs::validate "$cfg"; then
        boot__err "${cfg} failed schema validation"
        return 2
    fi
    RALPH_CONFIG="$cfg"
    export RALPH_CONFIG
    boot__info "PHASE_END phase=load-config config=${cfg}"
}

# ---- main --------------------------------------------------------------------

boot__main() {
    local now
    now=$(date -u +%FT%TZ)
    boot__info "ralph-harness slice 6 ec2-bootstrap"
    boot__info "instance=${INSTANCE_ID} region=${REGION} ts=${now}"
    boot__info "target=${RALPH_TARGET_REPO:-unset} log_group=${RALPH_LOG_GROUP} log_stream=${LOG_STREAM}"

    boot__start_cwagent
    boot__install_deps    || return $?
    boot__fetch_secrets   || return $?
    boot__clone_target    || return $?
    boot__safety_guards   || return $?
    boot__configure_mcps  || return $?
    boot__load_config     || return $?
    orch::run             || return $?
}

boot__main 2>&1 | tee -a "$LOG_FILE"
