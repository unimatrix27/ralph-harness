# shellcheck shell=bash
#
# ec2-orchestrator.sh — entry point for the three-call flow on a freshly
# bootstrapped EC2 instance. Slice 9 chains the review call onto the
# PR_OPENED branch from slice 8's implementation: bash sleep
# RALPH_REVIEW_WAIT_SEC (default 600s — the configured external review
# bot's window), render prompts/review.md with the runtime substitutions,
# fire one `claude --print` invocation, branch on
# /tmp/ralph/review-result.json. On REVISION_APPLIED the orchestrator
# appends one caveman-format line to the milestone-log issue (via
# `gsm::append_caveman_log` from lib/github-state-mutator.sh).
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
#   RALPH_LAUNCH_TAG         per-launch identifier embedded in PR bodies
#                            for slice 9 post-hoc correlation
#
# Reads from env (with overridable defaults):
#   RALPH_OUT_DIR                /tmp/ralph (output files contract)
#   RALPH_DISCOVERY_PROMPT       <repo>/prompts/discovery.md
#   RALPH_IMPLEMENTATION_PROMPT  <repo>/prompts/implementation.md
#   RALPH_REVIEW_PROMPT          <repo>/prompts/review.md
#   RALPH_REVIEW_WAIT_SEC        600 (10-minute sleep before review call)
#   RALPH_CLAUDE_BIN             claude
#   RALPH_CLAUDE_FLAGS           --permission-mode bypassPermissions
#
# Outputs (under $RALPH_OUT_DIR):
#   decision.json        status (PICKED|NONE|ALL_BLOCKED), picked issue, reasoning
#   issue.json           full gh payload of the picked issue (or {})
#   crafted-prompt.md    impl context for the implementation call
#   milestone-log.json   {milestone, log_issue} (or {})
#   impl-result.json     status (PR_OPENED|AGENT_STUCK), issue, pr_number, ...
#   review-result.json   status (NO_REVIEW|REVISION_APPLIED), summary, gotcha, ...
#
# Stable CloudWatch markers:
#   PHASE_START phase=<discovery|implementation|review> ts=...
#   PHASE_END   phase=<...> duration_s=... status=...
#   PICKED_ISSUE=<n>           emitted right after discovery PICKED so the
#                              launcher's post-hoc check (slice 9) can map a
#                              hard-killed instance back to its source issue
#   OUTCOME=<no_work|all_blocked|pr_opened|agent_stuck> [issue=<n>] [pr=<m>] [review=none|revised]
#
# Exit codes:
#   0   discovery completed (NONE/ALL_BLOCKED) OR implementation completed
#       and reported PR_OPENED|AGENT_STUCK (review may have run on PR_OPENED)
#   1   claude invocation failed
#   2   missing required env (target repo / work dir)
#   3   discovery, implementation, or review output contract violated
#       (missing/invalid file, unknown status)
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

# orch::__resolve_impl_prompt_path
#
# Resolves the implementation prompt template path. Honours
# RALPH_IMPLEMENTATION_PROMPT, otherwise falls back to
# ../prompts/implementation.md relative to this lib file.
orch::__resolve_impl_prompt_path() {
    if [[ -n "${RALPH_IMPLEMENTATION_PROMPT:-}" ]]; then
        printf '%s' "$RALPH_IMPLEMENTATION_PROMPT"
        return 0
    fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s' "${here}/../prompts/implementation.md"
}

# orch::__resolve_review_prompt_path
#
# Resolves the review prompt template path. Honours RALPH_REVIEW_PROMPT,
# otherwise falls back to ../prompts/review.md relative to this lib file.
orch::__resolve_review_prompt_path() {
    if [[ -n "${RALPH_REVIEW_PROMPT:-}" ]]; then
        printf '%s' "$RALPH_REVIEW_PROMPT"
        return 0
    fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s' "${here}/../prompts/review.md"
}

# orch::__render_impl_prompt <template-path> <crafted-prompt-path>
#
# Reads the implementation template and substitutes the {{PLACEHOLDER}}
# tokens. Appends the crafted context from discovery so the impl call
# receives one self-contained prompt on stdin. Substitution uses bash
# parameter expansion so values are treated as literal strings (no shell
# interpolation).
orch::__render_impl_prompt() {
    local template="$1" crafted="$2"
    if [[ ! -f "$template" ]]; then
        orch::__err "implementation prompt template not found: $template"
        return 3
    fi
    if [[ ! -f "$crafted" ]]; then
        orch::__err "crafted-prompt.md not found: $crafted"
        return 3
    fi

    local content
    content=$(cat "$template")

    local target_repo="${RALPH_TARGET_REPO:-}"
    local default_branch="${RALPH_DEFAULT_BRANCH:-}"
    local work_dir="${RALPH_WORK_DIR:-}"
    local launch_tag="${RALPH_LAUNCH_TAG:-}"
    local build_cmd test_cmd branch_prefix agent_stuck_label prompt_extension
    build_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.build_cmd')
    test_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.test_cmd')
    branch_prefix=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.branch_prefix')
    agent_stuck_label=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.agent_stuck_label')
    [[ -z "$agent_stuck_label" ]] && agent_stuck_label="agent-stuck"
    prompt_extension=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.prompt_extensions.implementation')

    content=${content//\{\{RALPH_TARGET_REPO\}\}/$target_repo}
    content=${content//\{\{RALPH_DEFAULT_BRANCH\}\}/$default_branch}
    content=${content//\{\{RALPH_WORK_DIR\}\}/$work_dir}
    content=${content//\{\{RALPH_BUILD_CMD\}\}/$build_cmd}
    content=${content//\{\{RALPH_TEST_CMD\}\}/$test_cmd}
    content=${content//\{\{RALPH_BRANCH_PREFIX\}\}/$branch_prefix}
    content=${content//\{\{RALPH_AGENT_STUCK_LABEL\}\}/$agent_stuck_label}
    content=${content//\{\{RALPH_LAUNCH_TAG\}\}/$launch_tag}
    content=${content//\{\{PROMPT_EXTENSION\}\}/$prompt_extension}

    printf '%s\n' "$content"
    printf '\n---\n\n## Crafted context from discovery\n\n'
    cat "$crafted"
}

# orch::__render_review_prompt <template-path> <issue#> <pr#> <pr-branch>
#
# Reads the review template and substitutes the {{PLACEHOLDER}} tokens.
# Pulls review_bot identity from RALPH_CONFIG. Substitution uses bash
# parameter expansion so values are treated as literal strings (no shell
# interpolation).
orch::__render_review_prompt() {
    local template="$1" issue="$2" pr_number="$3" pr_branch="$4"
    if [[ ! -f "$template" ]]; then
        orch::__err "review prompt template not found: $template"
        return 3
    fi

    local content
    content=$(cat "$template")

    local target_repo="${RALPH_TARGET_REPO:-}"
    local default_branch="${RALPH_DEFAULT_BRANCH:-}"
    local work_dir="${RALPH_WORK_DIR:-}"
    local build_cmd test_cmd review_bot_username review_bot_source prompt_extension
    build_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.build_cmd')
    test_cmd=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.test_cmd')
    review_bot_username=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.review_bot.username')
    review_bot_source=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.review_bot.source')
    prompt_extension=$(orch::__yq_or_empty "${RALPH_CONFIG:-}" '.prompt_extensions.review')

    content=${content//\{\{RALPH_TARGET_REPO\}\}/$target_repo}
    content=${content//\{\{RALPH_DEFAULT_BRANCH\}\}/$default_branch}
    content=${content//\{\{RALPH_WORK_DIR\}\}/$work_dir}
    content=${content//\{\{RALPH_BUILD_CMD\}\}/$build_cmd}
    content=${content//\{\{RALPH_TEST_CMD\}\}/$test_cmd}
    content=${content//\{\{RALPH_ISSUE_NUMBER\}\}/$issue}
    content=${content//\{\{RALPH_PR_NUMBER\}\}/$pr_number}
    content=${content//\{\{RALPH_PR_BRANCH\}\}/$pr_branch}
    content=${content//\{\{RALPH_REVIEW_BOT_USERNAME\}\}/$review_bot_username}
    content=${content//\{\{RALPH_REVIEW_BOT_SOURCE\}\}/$review_bot_source}
    content=${content//\{\{PROMPT_EXTENSION\}\}/$prompt_extension}

    printf '%s\n' "$content"
}

# orch::__verify_impl_output
#
# Confirms the implementation call wrote /tmp/ralph/impl-result.json
# and that it parses as JSON. Status validation happens in orch::run.
orch::__verify_impl_output() {
    local out="$1"
    if [[ ! -f "${out}/impl-result.json" ]]; then
        orch::__err "implementation did not write ${out}/impl-result.json"
        return 3
    fi
    if ! jq -e . "${out}/impl-result.json" >/dev/null 2>&1; then
        orch::__err "${out}/impl-result.json is not valid JSON"
        return 3
    fi
    return 0
}

# orch::__verify_review_output
#
# Confirms the review call wrote /tmp/ralph/review-result.json and that
# it parses as JSON. Status validation happens in orch::run.
orch::__verify_review_output() {
    local out="$1"
    if [[ ! -f "${out}/review-result.json" ]]; then
        orch::__err "review did not write ${out}/review-result.json"
        return 3
    fi
    if ! jq -e . "${out}/review-result.json" >/dev/null 2>&1; then
        orch::__err "${out}/review-result.json is not valid JSON"
        return 3
    fi
    return 0
}

# orch::__implementation <out-dir> <issue-number>
#
# Runs the implementation call. Wraps the claude invocation with phase
# markers and a wall-clock duration. Stdin to claude is the rendered
# template + crafted context concatenated; claude's stdout/stderr is
# forwarded to ours so CloudWatch captures it. The phase=implementation
# end marker carries the status read from impl-result.json (or
# `unknown` if the file is missing/unreadable) so a CloudWatch grep
# yields a one-line per-iteration summary.
orch::__implementation() {
    local out="$1" issue="$2"
    local prompt_path crafted rendered claude_bin
    prompt_path=$(orch::__resolve_impl_prompt_path)
    crafted="${out}/crafted-prompt.md"
    if ! rendered=$(orch::__render_impl_prompt "$prompt_path" "$crafted"); then
        return 3
    fi

    claude_bin="${RALPH_CLAUDE_BIN:-claude}"
    # shellcheck disable=SC2206
    local claude_flags=(${RALPH_CLAUDE_FLAGS:---permission-mode bypassPermissions})

    local started ended duration
    started=$(orch::__epoch)
    echo "PHASE_START phase=implementation ts=$(orch::__now) issue=${issue}"

    local rc=0
    printf '%s' "$rendered" | "$claude_bin" --print "${claude_flags[@]}" || rc=$?

    ended=$(orch::__epoch)
    duration=$(( ended - started ))

    local status="unknown"
    if [[ -f "${out}/impl-result.json" ]]; then
        local s
        s=$(jq -r '.status // ""' "${out}/impl-result.json" 2>/dev/null || true)
        [[ -n "$s" ]] && status="$s"
    fi
    echo "PHASE_END phase=implementation duration_s=${duration} issue=${issue} status=${status} ts=$(orch::__now)"

    if (( rc != 0 )); then
        orch::__err "claude implementation exited ${rc}"
        return 1
    fi
    return 0
}

# orch::__review <out-dir> <issue-number> <pr-number> <pr-branch>
#
# Sleeps RALPH_REVIEW_WAIT_SEC (default 600s — the configured external
# review bot's window), then runs the review call. Wraps the claude
# invocation with phase markers and a wall-clock duration. The
# phase=review end marker carries the status read from
# review-result.json so a CloudWatch grep yields a one-line summary.
orch::__review() {
    local out="$1" issue="$2" pr_number="$3" pr_branch="$4"

    local wait_sec="${RALPH_REVIEW_WAIT_SEC:-600}"
    if [[ "$wait_sec" =~ ^[0-9]+$ ]] && (( wait_sec > 0 )); then
        orch::__info "review: sleeping ${wait_sec}s for review bot window"
        sleep "$wait_sec"
    fi

    local prompt_path rendered claude_bin
    prompt_path=$(orch::__resolve_review_prompt_path)
    if ! rendered=$(orch::__render_review_prompt "$prompt_path" "$issue" "$pr_number" "$pr_branch"); then
        return 3
    fi

    claude_bin="${RALPH_CLAUDE_BIN:-claude}"
    # shellcheck disable=SC2206
    local claude_flags=(${RALPH_CLAUDE_FLAGS:---permission-mode bypassPermissions})

    local started ended duration
    started=$(orch::__epoch)
    echo "PHASE_START phase=review ts=$(orch::__now) issue=${issue} pr=${pr_number}"

    local rc=0
    printf '%s' "$rendered" | "$claude_bin" --print "${claude_flags[@]}" || rc=$?

    ended=$(orch::__epoch)
    duration=$(( ended - started ))

    local status="unknown"
    if [[ -f "${out}/review-result.json" ]]; then
        local s
        s=$(jq -r '.status // ""' "${out}/review-result.json" 2>/dev/null || true)
        [[ -n "$s" ]] && status="$s"
    fi
    echo "PHASE_END phase=review duration_s=${duration} issue=${issue} pr=${pr_number} status=${status} ts=$(orch::__now)"

    if (( rc != 0 )); then
        orch::__err "claude review exited ${rc}"
        return 1
    fi
    return 0
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

# orch::__append_caveman_log <issue#> <summary> <gotcha>
#
# Reads /tmp/ralph/milestone-log.json. If `.log_issue` is a non-null
# integer, calls `gsm::append_caveman_log` to post one caveman-format
# comment on it. No-op (clean exit 0) when the log issue is absent or
# the helper is missing.
orch::__append_caveman_log() {
    local out="$1" issue="$2" summary="$3" gotcha="$4"
    if ! command -v jq >/dev/null 2>&1; then
        orch::__info "review: jq missing; skipping caveman log append"
        return 0
    fi
    if [[ ! -f "${out}/milestone-log.json" ]]; then
        orch::__info "review: milestone-log.json missing; skipping caveman log append"
        return 0
    fi
    local log_issue
    log_issue=$(jq -r '.log_issue // empty' "${out}/milestone-log.json" 2>/dev/null)
    if [[ -z "$log_issue" || "$log_issue" == "null" ]]; then
        orch::__info "review: no milestone log issue recorded; skipping caveman log append"
        return 0
    fi
    if ! declare -F gsm::append_caveman_log >/dev/null 2>&1; then
        orch::__info "review: gsm::append_caveman_log unavailable; skipping caveman log append"
        return 0
    fi
    gsm::append_caveman_log "${RALPH_TARGET_REPO}" "$log_issue" "$issue" "$summary" "$gotcha" \
        || orch::__info "review: caveman log append returned non-zero (continuing)"
}

# orch::run
#
# Slice 9: discovery → implementation → review chain.
#   1. validate inputs
#   2. render discovery prompt; invoke claude (phase=discovery)
#   3. verify the four discovery output files
#   4. branch on decision.json.status:
#      NONE        -> OUTCOME=no_work       (clean exit 0)
#      ALL_BLOCKED -> OUTCOME=all_blocked   (clean exit 0)
#      PICKED      -> emit PICKED_ISSUE=<n> marker; render impl prompt;
#                     invoke claude (phase=implementation); verify
#                     impl-result.json; branch on impl status:
#                       PR_OPENED   -> sleep RALPH_REVIEW_WAIT_SEC; render
#                                      review prompt; invoke claude
#                                      (phase=review); verify
#                                      review-result.json; branch on review:
#                                        NO_REVIEW        -> OUTCOME=pr_opened ... review=none
#                                        REVISION_APPLIED -> append caveman log;
#                                                            OUTCOME=pr_opened ... review=revised
#                                        anything else    -> exit 3
#                       AGENT_STUCK -> OUTCOME=agent_stuck issue=<n>
#                       anything else -> exit 3
#      anything else -> exit 3
orch::run() {
    if [[ -z "${RALPH_TARGET_REPO:-}" ]]; then
        orch::__err "RALPH_TARGET_REPO is required"
        return 2
    fi

    local out="${RALPH_OUT_DIR:-/tmp/ralph}"
    export RALPH_OUT_DIR="$out"

    orch::__info "ralph-harness slice 9 orchestrator"
    orch::__info "target=${RALPH_TARGET_REPO} work_dir=${RALPH_WORK_DIR:-} default_branch=${RALPH_DEFAULT_BRANCH:-} config=${RALPH_CONFIG:-} out=${out} launch_tag=${RALPH_LAUNCH_TAG:-}"

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
            # Stable marker for the launcher's post-hoc agent-stuck check
            # (slice 9). Greppable from CloudWatch even if the box is
            # hard-killed before any later phase records state.
            echo "PICKED_ISSUE=${issue}"
            ;;
        *)
            orch::__err "decision.json has unknown status: '${status}'"
            return 3
            ;;
    esac

    orch::__implementation "$out" "$issue" || return $?
    orch::__verify_impl_output "$out" || return $?

    local impl_status pr_number pr_branch
    impl_status=$(jq -r '.status // ""'    "${out}/impl-result.json" 2>/dev/null)
    case "$impl_status" in
        PR_OPENED)
            pr_number=$(jq -r '.pr_number // ""' "${out}/impl-result.json" 2>/dev/null)
            pr_branch=$(jq -r '.branch // ""'    "${out}/impl-result.json" 2>/dev/null)
            if [[ -z "$pr_number" || "$pr_number" == "null" ]]; then
                orch::__err "impl-result.json status=PR_OPENED but no pr_number"
                return 3
            fi
            orch::__info "implementation opened PR #${pr_number} for issue #${issue}"
            ;;
        AGENT_STUCK)
            orch::__info "implementation reported agent_stuck for issue #${issue}"
            echo "OUTCOME=agent_stuck issue=${issue}"
            return 0
            ;;
        *)
            orch::__err "impl-result.json has unknown status: '${impl_status}'"
            return 3
            ;;
    esac

    # PR_OPENED branch — review call.
    orch::__review "$out" "$issue" "$pr_number" "$pr_branch" || return $?
    orch::__verify_review_output "$out" || return $?

    local review_status review_summary review_gotcha
    review_status=$(jq -r '.status // ""'  "${out}/review-result.json" 2>/dev/null)
    case "$review_status" in
        NO_REVIEW)
            orch::__info "review: no verdict from configured review bot; no caveman log appended"
            echo "OUTCOME=pr_opened issue=${issue} pr=${pr_number} review=none"
            return 0
            ;;
        REVISION_APPLIED)
            review_summary=$(jq -r '.summary // ""' "${out}/review-result.json" 2>/dev/null)
            review_gotcha=$(jq  -r '.gotcha  // ""' "${out}/review-result.json" 2>/dev/null)
            [[ -z "$review_summary" ]] && review_summary="review pass applied to PR #${pr_number}"
            orch::__append_caveman_log "$out" "$issue" "$review_summary" "$review_gotcha"
            orch::__info "review: revision applied to PR #${pr_number}"
            echo "OUTCOME=pr_opened issue=${issue} pr=${pr_number} review=revised"
            return 0
            ;;
        *)
            orch::__err "review-result.json has unknown status: '${review_status}'"
            return 3
            ;;
    esac
}
