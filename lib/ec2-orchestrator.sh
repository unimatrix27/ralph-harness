# shellcheck shell=bash
#
# ec2-orchestrator.sh — entry point for the three-call flow on a freshly
# bootstrapped EC2 instance. Slice 7 ships call 1 (discovery) end-to-end:
# render prompts/discovery.md with the runtime substitutions, fire one
# `claude --print` invocation, then branch on /tmp/ralph/decision.json.
# Slices 8 (implementation) and 9 (review) plug in after the PICKED
# branch.
#
# Public surface:
#   orch::run
#
# Reads from env (set by the cloud-init bootstrap):
#   RALPH_TARGET_REPO        owner/repo for the target
#   RALPH_AWS_REGION         AWS region (informational)
#   RALPH_WORK_DIR           absolute path to the fresh clone
#   RALPH_DEFAULT_BRANCH     resolved default branch of the target repo
#   RALPH_CONFIG             path to the validated .ralph/config.yaml
#
# Reads from env (with overridable defaults):
#   RALPH_OUT_DIR            /tmp/ralph (output files contract)
#   RALPH_DISCOVERY_PROMPT   <repo>/prompts/discovery.md
#   RALPH_CLAUDE_BIN         claude
#   RALPH_CLAUDE_FLAGS       --permission-mode bypassPermissions
#
# Outputs (always written under $RALPH_OUT_DIR by the discovery call):
#   decision.json        status (PICKED|NONE|ALL_BLOCKED), picked issue, reasoning
#   issue.json           full gh payload of the picked issue (or {})
#   crafted-prompt.md    impl context for slice 8
#   milestone-log.json   {milestone, log_issue} (or {})
#
# Exit codes:
#   0   discovery completed and decision is one of PICKED|NONE|ALL_BLOCKED
#   1   claude invocation failed
#   2   missing required env (target repo / work dir)
#   3   discovery output contract violated (missing/invalid file)
#
# Library file. Do not set strict shell options here (would affect callers).

orch::__info() {
    printf 'ec2-orchestrator: %s\n' "$*"
}

orch::__err() {
    printf 'ec2-orchestrator: error: %s\n' "$*" >&2
}

orch::__now()       { date -u +%FT%TZ 2>/dev/null || date -u; }
orch::__epoch()     { date -u +%s; }

# orch::__resolve_prompt_path
#
# Resolves the discovery prompt template path. Honours
# RALPH_DISCOVERY_PROMPT, otherwise falls back to ../prompts/discovery.md
# relative to this lib file.
orch::__resolve_prompt_path() {
    if [[ -n "${RALPH_DISCOVERY_PROMPT:-}" ]]; then
        printf '%s' "$RALPH_DISCOVERY_PROMPT"
        return 0
    fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s' "${here}/../prompts/discovery.md"
}

# orch::__yq_or_empty <yaml-path> <jq-path>
#
# Best-effort yq read; emits empty string on any failure. Avoids hard-
# failing the discovery render when yq is missing or the optional field
# is absent.
orch::__yq_or_empty() {
    local file="$1" path="$2"
    if ! command -v yq >/dev/null 2>&1; then
        return 0
    fi
    [[ -f "$file" ]] || return 0
    local v
    v=$(yq eval "$path // \"\"" "$file" 2>/dev/null) || return 0
    [[ "$v" == "null" ]] && v=""
    printf '%s' "$v"
}

# orch::__render_prompt
#
# Reads the discovery template and substitutes the {{PLACEHOLDER}} tokens
# inline. Emits the rendered prompt on stdout. Substitution uses bash
# parameter expansion so values are treated as literal strings (no shell
# interpolation).
orch::__render_prompt() {
    local template="$1"
    if [[ ! -f "$template" ]]; then
        orch::__err "discovery prompt template not found: $template"
        return 3
    fi

    local content
    content=$(cat "$template")

    local target_repo="${RALPH_TARGET_REPO:-}"
    local default_branch="${RALPH_DEFAULT_BRANCH:-}"
    local work_dir="${RALPH_WORK_DIR:-}"
    local build_cmd test_cmd branch_prefix prompt_extension
    build_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.build_cmd')
    test_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.test_cmd')
    branch_prefix=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.branch_prefix')
    prompt_extension=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.prompt_extensions.discovery')

    content=${content//\{\{RALPH_TARGET_REPO\}\}/$target_repo}
    content=${content//\{\{RALPH_DEFAULT_BRANCH\}\}/$default_branch}
    content=${content//\{\{RALPH_WORK_DIR\}\}/$work_dir}
    content=${content//\{\{RALPH_BUILD_CMD\}\}/$build_cmd}
    content=${content//\{\{RALPH_TEST_CMD\}\}/$test_cmd}
    content=${content//\{\{RALPH_BRANCH_PREFIX\}\}/$branch_prefix}
    content=${content//\{\{PROMPT_EXTENSION\}\}/$prompt_extension}

    printf '%s\n' "$content"
}

# orch::__verify_outputs
#
# Confirms the discovery call wrote the four contract files. Returns
# non-zero with a useful message on first missing/invalid file.
orch::__verify_outputs() {
    local out="$1"
    local f
    for f in decision.json issue.json crafted-prompt.md milestone-log.json; do
        if [[ ! -f "${out}/${f}" ]]; then
            orch::__err "discovery did not write ${out}/${f}"
            return 3
        fi
    done
    if ! jq -e . "${out}/decision.json" >/dev/null 2>&1; then
        orch::__err "${out}/decision.json is not valid JSON"
        return 3
    fi
    return 0
}

# orch::__discovery
#
# Runs the discovery call. Wraps the claude invocation with phase
# markers and a wall-clock duration. Stdin to claude is the rendered
# prompt; claude's stdout/stderr is forwarded to ours so CloudWatch
# captures it. Returns whatever claude returns.
orch::__discovery() {
    local out="$1"
    local prompt_path rendered claude_bin
    prompt_path=$(orch::__resolve_prompt_path)
    if ! rendered=$(orch::__render_prompt "$prompt_path"); then
        return 3
    fi

    install -d -m 700 "$out" 2>/dev/null || mkdir -p "$out"

    claude_bin="${RALPH_CLAUDE_BIN:-claude}"
    # shellcheck disable=SC2206
    local claude_flags=(${RALPH_CLAUDE_FLAGS:---permission-mode bypassPermissions})

    local started ended duration
    started=$(orch::__epoch)
    echo "PHASE_START phase=discovery ts=$(orch::__now) target=${RALPH_TARGET_REPO:-unknown}"

    local rc=0
    printf '%s' "$rendered" | "$claude_bin" --print "${claude_flags[@]}" || rc=$?

    ended=$(orch::__epoch)
    duration=$(( ended - started ))
    echo "PHASE_END phase=discovery duration_s=${duration} ts=$(orch::__now)"

    if (( rc != 0 )); then
        orch::__err "claude discovery exited ${rc}"
        return 1
    fi
    return 0
}

# orch::run
#
# Slice 7: real discovery call.
#   1. validate inputs
#   2. render discovery prompt with runtime substitutions
#   3. invoke claude (phase=discovery, duration_s logged)
#   4. verify the four output files exist and decision.json is valid JSON
#   5. branch on decision.json.status:
#      NONE        -> OUTCOME=no_work       (clean exit 0)
#      ALL_BLOCKED -> OUTCOME=all_blocked   (clean exit 0)
#      PICKED      -> OUTCOME=picked        (subsequent slices continue)
#      anything else -> exit 3
orch::run() {
    if [[ -z "${RALPH_TARGET_REPO:-}" ]]; then
        orch::__err "RALPH_TARGET_REPO is required"
        return 2
    fi

    local out="${RALPH_OUT_DIR:-/tmp/ralph}"
    export RALPH_OUT_DIR="$out"

    orch::__info "ralph-harness slice 7 orchestrator"
    orch::__info "target=${RALPH_TARGET_REPO} work_dir=${RALPH_WORK_DIR:-} default_branch=${RALPH_DEFAULT_BRANCH:-} config=${RALPH_CONFIG:-} out=${out}"

    orch::__discovery "$out" || return $?
    orch::__verify_outputs "$out" || return $?

    local status issue
    status=$(jq -r '.status // ""' "${out}/decision.json" 2>/dev/null)
    issue=$(jq -r '.issue // ""'  "${out}/decision.json" 2>/dev/null)

    case "$status" in
        NONE)
            orch::__info "discovery returned NONE — no eligible candidates"
            echo "OUTCOME=no_work"
            return 0
            ;;
        ALL_BLOCKED)
            orch::__info "discovery returned ALL_BLOCKED — every candidate has unsatisfied blockers"
            echo "OUTCOME=all_blocked"
            return 0
            ;;
        PICKED)
            if [[ -z "$issue" || "$issue" == "null" ]]; then
                orch::__err "decision.json status=PICKED but no issue number"
                return 3
            fi
            orch::__info "discovery picked issue #${issue}"
            echo "OUTCOME=picked issue=${issue}"
            # Slices 8/9 plug in here. For slice 7 the run completes
            # successfully after surfacing the pick.
            return 0
            ;;
        *)
            orch::__err "decision.json has unknown status: '${status}'"
            return 3
            ;;
    esac
}
