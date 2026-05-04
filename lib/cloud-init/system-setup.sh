#!/usr/bin/env bash
#
# system-setup.sh — slice 5 OS-level setup. Runs as the first step of
# `ralph-orchestrate` on the EC2 worker, AFTER the user-data stub has
# installed Node + git + jq + awscli + the harness package.
#
# Scope (intentionally OS-level only — everything else is in TS):
#   1. start the amazon-cloudwatch-agent so /var/log/ralph.log streams
#      live to CloudWatch (every ~5s) — survives force-termination
#   2. install gh, .NET 10 SDK, Docker, and the claude CLI
#   3. fetch GitHub PAT and Claude OAuth credential from SSM SecureString
#      into mode-0600 files
#   4. clone the target repo on its resolved default branch
#   5. safety guards (default branch, clean working tree, origin matches
#      RALPH_TARGET_REPO)
#   6. configure claude MCPs (serena, morph-mcp, context7, github,
#      sequential-thinking; `memory` excluded)
#   7. validate .ralph/config.yaml via `ralph-validate-config`
#   8. write RALPH_WORK_DIR / RALPH_DEFAULT_BRANCH / RALPH_CONFIG /
#      RALPH_LAUNCH_TAG to /tmp/ralph/setup.env so the TS orchestrator
#      picks them up after this subprocess exits
#
# Inputs (env, set by ralph-fire's user-data stub):
#   RALPH_TARGET_REPO            required, owner/repo
#   RALPH_AWS_REGION             required, e.g. eu-central-1
#   RALPH_GITHUB_TOKEN_SSM_KEY   SSM SecureString name for the GitHub PAT
#   RALPH_CLAUDE_OAUTH_SSM_KEY   SSM SecureString name for the OAuth cred
#   RALPH_LOG_GROUP              CloudWatch log group
#
# Output: /tmp/ralph/setup.env (KEY=VALUE per line) — read by ralph-orchestrate
# after this script exits.

set -uo pipefail

: "${HOME:=/root}"
export HOME

# claude CLI refuses --permission-mode bypassPermissions when running as
# root unless IS_SANDBOX=1. cloud-init runs as root and the orchestrator
# needs the bypass. The throwaway EC2 (scoped IAM, no SSH, ≤75-min
# lifetime) is the sandbox this knob exists for.
export IS_SANDBOX=1

: "${RALPH_LOG_GROUP:=/ralph/main}"
: "${RALPH_GITHUB_TOKEN_SSM_KEY:=/ralph/github-pat}"
: "${RALPH_CLAUDE_OAUTH_SSM_KEY:=/ralph/claude-oauth-credential}"

LOG_FILE="/var/log/ralph.log"
: > "$LOG_FILE" 2>/dev/null || true

# ---- IMDSv2 + metadata -------------------------------------------------------

setup__md_token=$(curl -fsS -m 5 -X PUT \
    "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)

setup__md() {
    curl -fsS -m 5 \
        -H "X-aws-ec2-metadata-token: ${setup__md_token}" \
        "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
}

INSTANCE_ID=$(setup__md instance-id)
REGION="${RALPH_AWS_REGION:-$(setup__md placement/region)}"
LOG_STREAM="${INSTANCE_ID:-unknown-instance}"

# Per-launch identifier embedded by the implementation call as an HTML
# comment in the PR body so the launcher can correlate post-hoc when the
# instance was hard-killed before recording state. Defaults to the
# instance id; falls back to a timestamp+pid pair if IMDS is unreachable.
RALPH_LAUNCH_TAG="${INSTANCE_ID:-$(date -u +%s)-$$}"
export RALPH_LAUNCH_TAG

setup__info() { printf 'system-setup: %s\n' "$*"; }
setup__err()  { printf 'system-setup: error: %s\n' "$*" >&2; }

# Pulls a SecureString parameter, decrypts under the role's permitted KMS
# alias, prints the value to stdout. Caller redirects to a 0600 file.
setup__ssm_get() {
    local name="$1"
    aws --region "$REGION" ssm get-parameter \
        --name "$name" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text
}

# ---- live log streaming via amazon-cloudwatch-agent --------------------------

setup__start_cwagent() {
    setup__info "PHASE_START phase=cwagent stream=${LOG_STREAM}"
    if ! dnf -y -q --allowerasing install amazon-cloudwatch-agent >/dev/null 2>&1; then
        setup__err "amazon-cloudwatch-agent install failed; live log streaming disabled"
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
        setup__info "PHASE_END phase=cwagent"
    else
        setup__err "amazon-cloudwatch-agent failed to start; live log streaming disabled"
    fi
}

# ---- install OS deps (gh, .NET 10, Docker, claude) ---------------------------

setup__install_deps() {
    setup__info "PHASE_START phase=install-deps"

    # gh CLI — official rpm repo.
    dnf -y -q config-manager --add-repo \
        https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null
    dnf -y -q --allowerasing install gh >/dev/null

    # Docker — required by the github MCP container.
    dnf -y -q --allowerasing install docker >/dev/null
    systemctl enable --now docker >/dev/null 2>&1 || true

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

    setup__info "PHASE_END phase=install-deps"
}

# ---- fetch secrets from SSM --------------------------------------------------

setup__fetch_secrets() {
    setup__info "PHASE_START phase=fetch-secrets"

    local pat_dir="${HOME}/.ralph"
    install -d -m 700 "$pat_dir"
    local pat_file="${pat_dir}/github-pat"
    if ! setup__ssm_get "$RALPH_GITHUB_TOKEN_SSM_KEY" > "$pat_file"; then
        setup__err "could not fetch GitHub PAT from ${RALPH_GITHUB_TOKEN_SSM_KEY}"
        return 1
    fi
    chmod 600 "$pat_file"
    if ! gh auth login --with-token < "$pat_file" >/dev/null 2>&1; then
        setup__err "gh auth login failed"
        return 1
    fi
    if ! gh auth setup-git >/dev/null 2>&1; then
        setup__err "gh auth setup-git failed"
        return 1
    fi
    GH_TOKEN="$(<"$pat_file")"
    GITHUB_PERSONAL_ACCESS_TOKEN="$GH_TOKEN"
    export GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN

    local cred_dir="${HOME}/.claude"
    install -d -m 700 "$cred_dir"
    local cred_file="${cred_dir}/.credentials.json"
    if ! setup__ssm_get "$RALPH_CLAUDE_OAUTH_SSM_KEY" > "$cred_file"; then
        setup__err "could not fetch OAuth credential from ${RALPH_CLAUDE_OAUTH_SSM_KEY}"
        return 1
    fi
    chmod 600 "$cred_file"

    setup__info "PHASE_END phase=fetch-secrets"
}

# ---- fresh clone of target on resolved default branch ------------------------

setup__clone_target() {
    setup__info "PHASE_START phase=clone-target target=${RALPH_TARGET_REPO}"
    if [[ -z "${RALPH_TARGET_REPO:-}" ]]; then
        setup__err "RALPH_TARGET_REPO is required"
        return 2
    fi
    local default_branch
    default_branch=$(gh repo view "$RALPH_TARGET_REPO" \
        --json defaultBranchRef \
        --jq '.defaultBranchRef.name')
    if [[ -z "$default_branch" ]]; then
        setup__err "could not resolve default branch for ${RALPH_TARGET_REPO}"
        return 1
    fi
    local work_dir
    work_dir="$(mktemp -d -t ralph-work-XXXXXX)"
    if ! git clone --depth 1 --branch "$default_branch" \
            "https://github.com/${RALPH_TARGET_REPO}.git" "$work_dir" \
            >/dev/null 2>&1; then
        setup__err "git clone of ${RALPH_TARGET_REPO} failed"
        return 1
    fi
    RALPH_WORK_DIR="$work_dir"
    RALPH_DEFAULT_BRANCH="$default_branch"
    export RALPH_WORK_DIR RALPH_DEFAULT_BRANCH
    cd "$RALPH_WORK_DIR"
    setup__info "PHASE_END phase=clone-target branch=${default_branch} dir=${RALPH_WORK_DIR}"
}

# ---- safety guards -----------------------------------------------------------

setup__safety_guards() {
    setup__info "PHASE_START phase=safety-guards"
    cd "${RALPH_WORK_DIR:?work dir required}"

    local current_branch
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$current_branch" != "$RALPH_DEFAULT_BRANCH" ]]; then
        setup__err "post-clone branch is ${current_branch}, expected ${RALPH_DEFAULT_BRANCH}"
        return 1
    fi

    if [[ -n "$(git status --porcelain)" ]]; then
        setup__err "fresh clone has uncommitted state — refusing to continue"
        return 1
    fi

    local origin
    origin=$(git remote get-url origin)
    if [[ "$origin" != *"${RALPH_TARGET_REPO}"* ]]; then
        setup__err "origin (${origin}) does not match RALPH_TARGET_REPO (${RALPH_TARGET_REPO})"
        return 1
    fi

    setup__info "PHASE_END phase=safety-guards"
}

# ---- configure claude MCPs (memory excluded) ---------------------------------

setup__configure_mcps() {
    setup__info "PHASE_START phase=configure-mcps"
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
    setup__info "PHASE_END phase=configure-mcps"
}

# ---- validate target config via ralph-validate-config ------------------------

setup__validate_config() {
    setup__info "PHASE_START phase=validate-config"
    local cfg="${RALPH_WORK_DIR}/.ralph/config.yaml"
    if [[ ! -f "$cfg" ]]; then
        setup__err "${RALPH_TARGET_REPO} is missing .ralph/config.yaml — refusing to continue"
        return 2
    fi
    if ! ralph-validate-config "$cfg" >/dev/null; then
        setup__err "${cfg} failed schema validation"
        return 2
    fi
    RALPH_CONFIG="$cfg"
    export RALPH_CONFIG
    setup__info "PHASE_END phase=validate-config config=${cfg}"
}

# ---- write setup.env for ralph-orchestrate -----------------------------------

setup__write_env_file() {
    install -d -m 755 /tmp/ralph
    cat > /tmp/ralph/setup.env <<EOF
RALPH_WORK_DIR=${RALPH_WORK_DIR}
RALPH_DEFAULT_BRANCH=${RALPH_DEFAULT_BRANCH}
RALPH_CONFIG=${RALPH_CONFIG}
RALPH_LAUNCH_TAG=${RALPH_LAUNCH_TAG}
EOF
    chmod 644 /tmp/ralph/setup.env
}

# ---- main --------------------------------------------------------------------

setup__main() {
    local now
    now=$(date -u +%FT%TZ)
    setup__info "ralph-harness slice 5 system-setup"
    setup__info "instance=${INSTANCE_ID} region=${REGION} ts=${now}"
    setup__info "target=${RALPH_TARGET_REPO:-unset} log_group=${RALPH_LOG_GROUP} log_stream=${LOG_STREAM}"

    setup__start_cwagent
    setup__install_deps    || return $?
    setup__fetch_secrets   || return $?
    setup__clone_target    || return $?
    setup__safety_guards   || return $?
    setup__configure_mcps  || return $?
    setup__validate_config || return $?
    setup__write_env_file
}

# Stdout is already routed to /var/log/ralph.log by the user-data stub's
# `exec > >(tee -a /var/log/ralph.log) 2>&1`; teeing again here would
# double-write every line into the cwagent stream.
setup__main 2>&1
