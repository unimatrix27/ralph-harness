# shellcheck shell=bash
#
# fire-launcher.sh — fires one throwaway EC2 instance per iteration and
# enforces the wall-clock backstop from the laptop side. Slice 6 swapped
# the slice-5 hello payload for the real ec2-bootstrap: install deps,
# fetch SSM secrets, fresh-clone the target, validate .ralph/config.yaml,
# then hand off to the orchestrator. Slice 9 adds a post-hoc
# agent-stuck check that runs after the instance terminates: if no PR
# carrying the launch tag exists on the target repo and the picked
# issue is recoverable from CloudWatch (PICKED_ISSUE=<n> marker), the
# launcher labels the source issue agent-stuck. Covers the case where
# the box is hard-killed (wall-clock breach, orchestrator crash) before
# the impl call could self-label.
#
# Public surface:
#   fire::run
#
# Reads from env (required):
#   RALPH_TARGET_REPO        owner/repo of the target
#
# Reads from env (with overridable defaults):
#   RALPH_AWS_REGION              eu-central-1
#   RALPH_LOG_GROUP               /ralph/main
#   RALPH_GITHUB_TOKEN_SSM_KEY    /ralph/github-pat
#   RALPH_CLAUDE_OAUTH_SSM_KEY    /ralph/claude-oauth-credential
#   RALPH_INSTANCE_TYPE           t3a.large
#   RALPH_ROOT_VOLUME_GB          30
#   RALPH_SG_NAME                 ralph-sg               (from aws-bootstrap)
#   RALPH_IAM_PROFILE             ralph-ec2-profile      (from aws-bootstrap)
#   RALPH_AMI_SSM_PARAM           /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
#   RALPH_MAX_LIFETIME_MIN        75
#   RALPH_POLL_INTERVAL_SEC       20
#   RALPH_AGENT_STUCK_LABEL       agent-stuck            (post-hoc label)
#   FIRE_USER_DATA_FILE           override; if set, used verbatim as the
#                                 sole cloud-init payload (no lib bundling)
#
# Exit codes:
#   0   instance terminated cleanly within the ceiling
#   2   missing AWS-side resource (e.g. security group not bootstrapped)
#   3   wall-clock ceiling breached; force terminate-instances was issued
#   non-zero   propagated from `aws`
#
# Cleanup contract (defense in depth):
#   - cloud-init runs `shutdown -h now` via a bash EXIT trap
#   - the instance is launched with --instance-initiated-shutdown-behavior=terminate
#   - this launcher polls describe-instances and force-terminates on ceiling
#
# Networking / posture:
#   - default VPC, default-AZ public subnet, auto-assigned public IP
#   - security group has no inbound rules; SSM Session Manager is the only
#     debug entry point
#   - no SSH keys ever
#
# Dependencies: aws CLI v2 (authenticated, region-aware), jq.
#
# Library file. Do not set strict shell options here (would affect callers).

FIRE_REGION="${RALPH_AWS_REGION:-eu-central-1}"
FIRE_LOG_GROUP="${RALPH_LOG_GROUP:-/ralph/main}"
FIRE_GITHUB_TOKEN_SSM_KEY="${RALPH_GITHUB_TOKEN_SSM_KEY:-/ralph/github-pat}"
FIRE_CLAUDE_OAUTH_SSM_KEY="${RALPH_CLAUDE_OAUTH_SSM_KEY:-/ralph/claude-oauth-credential}"
FIRE_INSTANCE_TYPE="${RALPH_INSTANCE_TYPE:-t3a.large}"
FIRE_ROOT_VOLUME_GB="${RALPH_ROOT_VOLUME_GB:-30}"
FIRE_SG_NAME="${RALPH_SG_NAME:-ralph-sg}"
FIRE_IAM_PROFILE="${RALPH_IAM_PROFILE:-ralph-ec2-profile}"
FIRE_AMI_SSM_PARAM="${RALPH_AMI_SSM_PARAM:-/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}"
FIRE_MAX_LIFETIME_MIN="${RALPH_MAX_LIFETIME_MIN:-75}"
FIRE_POLL_INTERVAL_SEC="${RALPH_POLL_INTERVAL_SEC:-20}"
FIRE_AGENT_STUCK_LABEL="${RALPH_AGENT_STUCK_LABEL:-agent-stuck}"

fire::__err()  { printf 'fire-launcher: error: %s\n' "$*" >&2; }
fire::__info() { printf 'fire-launcher: %s\n' "$*"; }

fire::__aws() { aws --region "$FIRE_REGION" "$@"; }

fire::__resolve_default_vpc() {
    local vpc_id
    vpc_id=$(fire::__aws ec2 describe-vpcs \
        --filters Name=is-default,Values=true \
        --query 'Vpcs[0].VpcId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
        fire::__err "no default VPC in region ${FIRE_REGION}"
        return 2
    fi
    printf '%s' "$vpc_id"
}

fire::__resolve_public_subnet() {
    local vpc_id="${1:?vpc_id required}"
    local subnet_id
    subnet_id=$(fire::__aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=default-for-az,Values=true" \
        --query 'Subnets[0].SubnetId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$subnet_id" || "$subnet_id" == "None" ]]; then
        fire::__err "no default subnet in vpc ${vpc_id}"
        return 2
    fi
    printf '%s' "$subnet_id"
}

fire::__resolve_security_group() {
    local vpc_id="${1:?vpc_id required}"
    local name="${2:?name required}"
    local sg_id
    sg_id=$(fire::__aws ec2 describe-security-groups \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=group-name,Values=${name}" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
        fire::__err "security group ${name} not found in vpc ${vpc_id}; run bin/bootstrap-aws.sh first"
        return 2
    fi
    printf '%s' "$sg_id"
}

fire::__resolve_image_id() {
    local image_id
    image_id=$(fire::__aws ssm get-parameter \
        --name "$FIRE_AMI_SSM_PARAM" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$image_id" || "$image_id" == "None" ]]; then
        fire::__err "could not resolve AL2023 image id from ${FIRE_AMI_SSM_PARAM}"
        return 2
    fi
    printf '%s' "$image_id"
}

# fire::__user_data_files
#
# Emits one path per line, in the order they should be concatenated into
# the rendered user-data. By default returns the slice-6 bundle:
# target-config-schema.sh + ec2-orchestrator.sh + cloud-init/bootstrap.sh.
# An FIRE_USER_DATA_FILE override replaces the entire bundle with one
# self-contained file (used by integration smoke tests).
fire::__user_data_files() {
    if [[ -n "${FIRE_USER_DATA_FILE:-}" ]]; then
        printf '%s\n' "$FIRE_USER_DATA_FILE"
        return 0
    fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s\n' "${here}/target-config-schema.sh"
    printf '%s\n' "${here}/github-state-mutator.sh"
    printf '%s\n' "${here}/ec2-orchestrator.sh"
    printf '%s\n' "${here}/cloud-init/bootstrap.sh"
}

# fire::__prompt_files
#
# Emits one path per line for prompt templates that should be embedded
# as on-disk files in the rendered user-data. Slice 7 shipped discovery,
# slice 8 added implementation, slice 9 adds review.
fire::__prompt_files() {
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    printf '%s\n' "${here}/prompts/discovery.md"
    printf '%s\n' "${here}/prompts/implementation.md"
    printf '%s\n' "${here}/prompts/review.md"
}

# fire::__embed_prompt <abs-prompt-path>
#
# Emits a heredoc snippet that, when run on the EC2 worker, materializes
# the prompt template at /opt/ralph/prompts/<basename>. Using a
# quoted-EOF heredoc preserves the file verbatim — no shell interpolation,
# no substitution. The orchestrator picks the file up via
# RALPH_DISCOVERY_PROMPT (set in the env shim).
fire::__embed_prompt() {
    local path="${1:?prompt path required}"
    local base="${path##*/}"
    local sentinel
    sentinel="RALPH_PROMPT_EOF_$(printf '%s' "$base" | tr -c '[:alnum:]' _)"
    printf '\n# ---- embedded prompt %s ----\n' "$base"
    printf 'install -d -m 755 /opt/ralph/prompts\n'
    printf "cat > /opt/ralph/prompts/%s <<'%s'\n" "$base" "$sentinel"
    cat "$path"
    printf '\n%s\n' "$sentinel"
    printf 'chmod 644 /opt/ralph/prompts/%s\n' "$base"
}

# fire::__render_user_data <log-group>
#
# Emits a complete cloud-init script: one shebang at the top, a small
# env shim exporting the runtime knobs the payload reads, the embedded
# prompt templates written to /opt/ralph/prompts/, then the bundled lib
# files concatenated with their leading shebangs stripped. The last file
# in the bundle (cloud-init/bootstrap.sh) contains the entry call.
fire::__render_user_data() {
    local log_group="${1:?log_group required}"
    local target_repo="${RALPH_TARGET_REPO:-}"
    local github_key="${FIRE_GITHUB_TOKEN_SSM_KEY}"
    local oauth_key="${FIRE_CLAUDE_OAUTH_SSM_KEY}"

    local files prompts
    if ! mapfile -t files < <(fire::__user_data_files); then
        fire::__err "could not resolve user-data files"
        return 2
    fi
    if ! mapfile -t prompts < <(fire::__prompt_files); then
        fire::__err "could not resolve prompt files"
        return 2
    fi
    local f
    for f in "${files[@]}" "${prompts[@]}"; do
        if [[ ! -f "$f" ]]; then
            fire::__err "user-data file not found: ${f}"
            return 2
        fi
    done

    {
        printf '#!/bin/bash\n'
        printf 'export RALPH_LOG_GROUP=%q\n'             "$log_group"
        printf 'export RALPH_TARGET_REPO=%q\n'           "$target_repo"
        printf 'export RALPH_AWS_REGION=%q\n'            "$FIRE_REGION"
        printf 'export RALPH_GITHUB_TOKEN_SSM_KEY=%q\n'  "$github_key"
        printf 'export RALPH_CLAUDE_OAUTH_SSM_KEY=%q\n'  "$oauth_key"
        printf 'export RALPH_DISCOVERY_PROMPT=%q\n'      "/opt/ralph/prompts/discovery.md"
        printf 'export RALPH_IMPLEMENTATION_PROMPT=%q\n'  "/opt/ralph/prompts/implementation.md"
        printf 'export RALPH_REVIEW_PROMPT=%q\n'          "/opt/ralph/prompts/review.md"
        for f in "${prompts[@]}"; do
            fire::__embed_prompt "$f"
        done
        for f in "${files[@]}"; do
            printf '\n# ---- bundled %s ----\n' "${f##*/}"
            sed '1{/^#!/d;}' "$f"
        done
    }
}

fire::__tag_spec() {
    local max="${1:?max required}"
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat <<JSON
[
  {"ResourceType":"instance","Tags":[
    {"Key":"Project","Value":"ralph"},
    {"Key":"Name","Value":"ralph-harness"},
    {"Key":"LaunchedAt","Value":"${ts}"},
    {"Key":"MaxLifetimeMin","Value":"${max}"}
  ]},
  {"ResourceType":"volume","Tags":[
    {"Key":"Project","Value":"ralph"},
    {"Key":"LaunchedAt","Value":"${ts}"},
    {"Key":"MaxLifetimeMin","Value":"${max}"}
  ]}
]
JSON
}

fire::__block_device_mapping() {
    local gb="${1:?gb required}"
    cat <<JSON
[{
  "DeviceName":"/dev/xvda",
  "Ebs":{"VolumeSize":${gb},"VolumeType":"gp3","DeleteOnTermination":true}
}]
JSON
}

fire::__run_instance() {
    local image_id="${1:?image_id required}"
    local subnet_id="${2:?subnet_id required}"
    local sg_id="${3:?sg_id required}"
    local user_data_file="${4:?user_data_file required}"
    local tag_file="${5:?tag_file required}"
    local bdm_file="${6:?bdm_file required}"

    fire::__aws ec2 run-instances \
        --image-id "$image_id" \
        --instance-type "$FIRE_INSTANCE_TYPE" \
        --subnet-id "$subnet_id" \
        --security-group-ids "$sg_id" \
        --associate-public-ip-address \
        --iam-instance-profile "Name=${FIRE_IAM_PROFILE}" \
        --instance-initiated-shutdown-behavior terminate \
        --user-data "file://${user_data_file}" \
        --block-device-mappings "file://${bdm_file}" \
        --tag-specifications "file://${tag_file}" \
        --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2" \
        --query 'Instances[0].InstanceId' \
        --output text
}

# fire::__wait_for_terminated <instance-id>
#
# Polls describe-instances until State.Name == terminated. On wall-clock
# ceiling breach issues a force terminate-instances and returns 3.
fire::__wait_for_terminated() {
    local instance_id="${1:?instance_id required}"
    local deadline
    deadline=$(( $(date +%s) + FIRE_MAX_LIFETIME_MIN * 60 ))
    while :; do
        local state
        state=$(fire::__aws ec2 describe-instances \
            --instance-ids "$instance_id" \
            --query 'Reservations[0].Instances[0].State.Name' \
            --output text 2>/dev/null) || state=""
        case "$state" in
            terminated)
                fire::__info "instance ${instance_id} terminated"
                return 0
                ;;
            "")
                fire::__info "could not read state for ${instance_id}; retrying"
                ;;
            *)
                fire::__info "instance ${instance_id} state=${state}"
                ;;
        esac
        if (( $(date +%s) >= deadline )); then
            fire::__err "wall-clock ceiling (${FIRE_MAX_LIFETIME_MIN}m) breached; forcing terminate"
            fire::__aws ec2 terminate-instances --instance-ids "$instance_id" >/dev/null 2>&1 || true
            return 3
        fi
        sleep "$FIRE_POLL_INTERVAL_SEC"
    done
}

# fire::__pr_with_launch_tag_exists <target-repo> <launch-tag>
#
# Returns 0 (true) if the target repo has at least one PR (any state)
# whose body contains the `<!-- ralph-launch: <tag> -->` marker the
# implementation call embeds. Returns 1 (false) on absence; on any gh
# failure (auth/network/rate) returns 1 as well so the caller treats
# the absence as "unknown" — the worst case is a duplicate
# `agent-stuck` label, which gsm::swap_label-style idempotency in the
# label edit makes a no-op anyway.
fire::__pr_with_launch_tag_exists() {
    local target_repo="${1:?target_repo required}"
    local launch_tag="${2:?launch_tag required}"
    if ! command -v gh >/dev/null 2>&1; then
        fire::__info "post-hoc: gh not on PATH; skipping PR-tag check"
        return 1
    fi
    local count
    count=$(gh pr list \
        --repo "$target_repo" \
        --state all \
        --limit 50 \
        --json number,body \
        --jq "[.[] | select(.body // \"\" | contains(\"ralph-launch: ${launch_tag}\"))] | length" \
        2>/dev/null)
    [[ -z "$count" ]] && count=0
    (( count > 0 ))
}

# fire::__fetch_picked_issue <instance-id>
#
# Greps the per-instance CloudWatch log stream for the orchestrator's
# `PICKED_ISSUE=<n>` marker and emits the integer on stdout (empty if
# not found). Tolerates missing log group / stream / aws failures by
# emitting nothing.
fire::__fetch_picked_issue() {
    local instance_id="${1:?instance_id required}"
    local raw issue
    raw=$(fire::__aws logs filter-log-events \
        --log-group-name "$FIRE_LOG_GROUP" \
        --log-stream-names "$instance_id" \
        --filter-pattern '"PICKED_ISSUE="' \
        --output json 2>/dev/null) || return 0
    [[ -z "$raw" ]] && return 0
    if command -v jq >/dev/null 2>&1; then
        issue=$(printf '%s' "$raw" \
            | jq -r '.events[]?.message // empty' 2>/dev/null \
            | grep -oE 'PICKED_ISSUE=[0-9]+' \
            | head -n 1 \
            | cut -d= -f2)
    else
        issue=$(printf '%s' "$raw" \
            | grep -oE 'PICKED_ISSUE=[0-9]+' \
            | head -n 1 \
            | cut -d= -f2)
    fi
    [[ -n "$issue" ]] && printf '%s' "$issue"
    return 0
}

# fire::__post_hoc_stuck_check <instance-id> <launch-tag>
#
# Slice 9 contract: after the EC2 has terminated, if no PR carrying the
# launch tag is on the target repo, treat the run as agent-stuck for
# the picked issue and apply the configured stuck-label from the
# laptop side. Covers wall-clock-killed and orchestrator-crashed cases
# where the impl call could not self-label.
#
# Always returns 0 — post-hoc bookkeeping must never mask the actual
# wait_for_terminated exit code from the caller.
fire::__post_hoc_stuck_check() {
    local instance_id="${1:?instance_id required}"
    local launch_tag="${2:?launch_tag required}"
    local target_repo="${RALPH_TARGET_REPO:-}"
    [[ -z "$target_repo" ]] && return 0

    if fire::__pr_with_launch_tag_exists "$target_repo" "$launch_tag"; then
        fire::__info "post-hoc: PR with launch tag ${launch_tag} present; clean termination"
        return 0
    fi

    local picked_issue
    picked_issue=$(fire::__fetch_picked_issue "$instance_id")
    if [[ -z "$picked_issue" ]]; then
        fire::__info "post-hoc: no PR for launch ${launch_tag} and no picked issue recoverable from CloudWatch; nothing to label"
        return 0
    fi

    fire::__info "post-hoc: no PR for launch ${launch_tag}; applying ${FIRE_AGENT_STUCK_LABEL} to ${target_repo}#${picked_issue}"
    if ! command -v gh >/dev/null 2>&1; then
        fire::__info "post-hoc: gh not on PATH; cannot apply ${FIRE_AGENT_STUCK_LABEL} label"
        return 0
    fi
    gh issue edit "$picked_issue" \
        --repo "$target_repo" \
        --add-label "$FIRE_AGENT_STUCK_LABEL" >/dev/null 2>&1 \
        || fire::__info "post-hoc: gh issue edit returned non-zero (label may already be present)"
    return 0
}

fire::run() {
    if [[ -z "${RALPH_TARGET_REPO:-}" ]]; then
        fire::__err "RALPH_TARGET_REPO is required (e.g. owner/repo)"
        return 2
    fi

    local vpc_id subnet_id sg_id image_id
    vpc_id=$(fire::__resolve_default_vpc) || return $?
    subnet_id=$(fire::__resolve_public_subnet "$vpc_id") || return $?
    sg_id=$(fire::__resolve_security_group "$vpc_id" "$FIRE_SG_NAME") || return $?
    image_id=$(fire::__resolve_image_id) || return $?

    fire::__info "region=${FIRE_REGION} vpc=${vpc_id} subnet=${subnet_id} sg=${sg_id} ami=${image_id}"
    fire::__info "instance_type=${FIRE_INSTANCE_TYPE} root_gb=${FIRE_ROOT_VOLUME_GB} max_lifetime_min=${FIRE_MAX_LIFETIME_MIN}"
    fire::__info "target=${RALPH_TARGET_REPO} log_group=${FIRE_LOG_GROUP}"
    fire::__info "github_key=${FIRE_GITHUB_TOKEN_SSM_KEY} oauth_key=${FIRE_CLAUDE_OAUTH_SSM_KEY}"

    local tmp
    tmp=$(mktemp -d -t ralph-fire) || return $?
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT INT TERM

    local user_data_file="${tmp}/user-data.sh"
    local tag_file="${tmp}/tags.json"
    local bdm_file="${tmp}/bdm.json"
    fire::__render_user_data "$FIRE_LOG_GROUP" > "$user_data_file" || return $?
    fire::__tag_spec "$FIRE_MAX_LIFETIME_MIN" > "$tag_file"
    fire::__block_device_mapping "$FIRE_ROOT_VOLUME_GB" > "$bdm_file"

    local instance_id
    instance_id=$(fire::__run_instance \
        "$image_id" "$subnet_id" "$sg_id" \
        "$user_data_file" "$tag_file" "$bdm_file") || return $?
    if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
        fire::__err "run-instances did not return an instance id"
        return 1
    fi
    fire::__info "launched ${instance_id}"
    fire::__info "log_group=${FIRE_LOG_GROUP} log_stream=${instance_id}"
    fire::__info "tail with: aws --region ${FIRE_REGION} logs tail ${FIRE_LOG_GROUP} --log-stream-names ${instance_id} --follow"

    local wait_rc=0
    fire::__wait_for_terminated "$instance_id" || wait_rc=$?

    # Slice 9 post-hoc agent-stuck check. Runs unconditionally so it
    # also covers the wall-clock-breach (rc=3) path. The launch tag
    # mirrors the EC2 instance id (set by lib/cloud-init/bootstrap.sh
    # as RALPH_LAUNCH_TAG).
    fire::__post_hoc_stuck_check "$instance_id" "$instance_id"

    return "$wait_rc"
}
