# shellcheck shell=bash
#
# github-state-mutator.sh — idempotent shell wrappers around `gh` for the
# state mutations the orchestrator needs:
#
#   gsm::swap_label <repo> <issue#> <from-label> <to-label>
#   gsm::comment_issue <repo> <issue#> <body>
#   gsm::find_or_create_milestone_log_issue <repo> <milestone>   # echoes #
#   gsm::append_caveman_log <repo> <log#> <issue#> <summary> [<gotcha>]
#
# Idempotency: every operation is a no-op success when its target state is
# already in place. Callers can re-invoke after a partial failure without
# manual cleanup.
#
# Exit codes:
#   0   success
#   2   usage / missing required argument
#   non-zero   propagated from `gh`
#
# Dependencies: gh (authenticated for the target repo); jq for `gh --jq`.
#
# Library file. Do not set strict shell options here (would affect callers).

gsm::__err() {
    printf 'github-state-mutator: error: %s\n' "$*" >&2
}

gsm::__require_args() {
    local fn="$1" want="$2" got="$3"
    if (( got < want )); then
        gsm::__err "${fn}: expected ${want} args, got ${got}"
        return 2
    fi
}

# gsm::swap_label <repo> <issue#> <from-label> <to-label>
#
# Removes <from-label> if present, adds <to-label> if missing. Idempotent:
# if the issue already has <to-label> and not <from-label>, no edit call is
# made.
gsm::swap_label() {
    gsm::__require_args swap_label 4 "$#" || return $?
    local repo="$1" num="$2" from="$3" to="$4"

    local labels
    labels=$(gh issue view "$num" --repo "$repo" --json labels --jq '.labels[].name') || {
        gsm::__err "swap_label: could not read labels for ${repo}#${num}"
        return $?
    }

    local has_from=0 has_to=0 line
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        [[ "$line" == "$from" ]] && has_from=1
        [[ "$line" == "$to" ]] && has_to=1
    done <<< "$labels"

    local args=(issue edit "$num" --repo "$repo")
    local need_call=0
    if (( has_from )); then
        args+=(--remove-label "$from")
        need_call=1
    fi
    if (( ! has_to )); then
        args+=(--add-label "$to")
        need_call=1
    fi

    if (( need_call )); then
        gh "${args[@]}"
    fi
}

# gsm::comment_issue <repo> <issue#> <body>
gsm::comment_issue() {
    gsm::__require_args comment_issue 3 "$#" || return $?
    local repo="$1" num="$2" body="$3"
    gh issue comment "$num" --repo "$repo" --body "$body"
}

# gsm::find_or_create_milestone_log_issue <repo> <milestone>
#
# Looks for an issue titled exactly `[log] <milestone>` carrying the
# `meta:milestone-log` label. Creates one if missing. Echoes the issue
# number on stdout.
gsm::find_or_create_milestone_log_issue() {
    gsm::__require_args find_or_create_milestone_log_issue 2 "$#" || return $?
    local repo="$1" milestone="$2"
    local title="[log] ${milestone}"

    local existing
    existing=$(gh issue list \
        --repo "$repo" \
        --label meta:milestone-log \
        --state all \
        --json number,title \
        --limit 100 \
        --jq ".[] | select(.title == \"${title}\") | .number" \
        | head -n 1)

    if [[ -n "$existing" ]]; then
        printf '%s\n' "$existing"
        return 0
    fi

    local body
    body="This issue is the cross-iteration learnings log for milestone '${milestone}'.

Each ralph-harness implementation iteration appends one comment in caveman format:

    #<issue> | <one-line summary> | <gotcha or '-'>

Do not close manually — the harness reads recent comments here for prior-iteration context."

    local url
    url=$(gh issue create \
        --repo "$repo" \
        --title "$title" \
        --label meta:milestone-log \
        --body "$body") || return $?

    # `gh issue create` prints the new issue URL on stdout.
    printf '%s\n' "${url##*/}"
}

# gsm::append_caveman_log <repo> <log#> <issue#> <summary> [<gotcha>]
#
# Posts one caveman-format comment on the milestone-log issue.
# Empty/missing gotcha is rendered as `-`.
gsm::append_caveman_log() {
    gsm::__require_args append_caveman_log 4 "$#" || return $?
    local repo="$1" log_num="$2" issue_num="$3" summary="$4"
    local gotcha="${5:-}"
    [[ -z "$gotcha" ]] && gotcha="-"
    gsm::comment_issue "$repo" "$log_num" "#${issue_num} | ${summary} | ${gotcha}"
}
