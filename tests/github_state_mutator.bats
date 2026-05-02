#!/usr/bin/env bats
#
# Tests for lib/github-state-mutator.sh. Stubs `gh` via temp-dir-on-PATH
# and asserts on the captured invocation log.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    STUB_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$STUB_BIN"
    cp "${BATS_TEST_DIRNAME}/stubs/gh" "${STUB_BIN}/gh"
    chmod +x "${STUB_BIN}/gh"
    PATH="${STUB_BIN}:${PATH}"
    export PATH

    GH_STUB_LOG="${BATS_TEST_TMPDIR}/gh.log"
    : > "$GH_STUB_LOG"
    export GH_STUB_LOG

    # shellcheck source=../lib/github-state-mutator.sh
    source "${ROOT}/lib/github-state-mutator.sh"
}

# ---- swap_label ----

@test "swap_label: removes from-label and adds to-label when both states need changing" {
    export GH_STUB_OUT_ISSUE_VIEW=$'ready-for-agent\nbug'
    run gsm::swap_label "owner/repo" 42 "ready-for-agent" "ready-for-human"
    [ "$status" -eq 0 ]
    grep -q '^arg=issue$' "$GH_STUB_LOG"
    grep -q '^arg=edit$' "$GH_STUB_LOG"
    grep -q '^arg=--remove-label$' "$GH_STUB_LOG"
    grep -q '^arg=ready-for-agent$' "$GH_STUB_LOG"
    grep -q '^arg=--add-label$' "$GH_STUB_LOG"
    grep -q '^arg=ready-for-human$' "$GH_STUB_LOG"
}

@test "swap_label: idempotent when target label already applied" {
    export GH_STUB_OUT_ISSUE_VIEW=$'ready-for-human\nbug'
    run gsm::swap_label "owner/repo" 42 "ready-for-agent" "ready-for-human"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=edit$' "$GH_STUB_LOG"
}

@test "swap_label: only adds when neither label present" {
    export GH_STUB_OUT_ISSUE_VIEW=$'bug'
    run gsm::swap_label "owner/repo" 42 "ready-for-agent" "ready-for-human"
    [ "$status" -eq 0 ]
    grep -q '^arg=edit$' "$GH_STUB_LOG"
    grep -q '^arg=--add-label$' "$GH_STUB_LOG"
    ! grep -q '^arg=--remove-label$' "$GH_STUB_LOG"
}

@test "swap_label: only removes when from present and to also already present" {
    export GH_STUB_OUT_ISSUE_VIEW=$'ready-for-agent\nready-for-human'
    run gsm::swap_label "owner/repo" 42 "ready-for-agent" "ready-for-human"
    [ "$status" -eq 0 ]
    grep -q '^arg=edit$' "$GH_STUB_LOG"
    grep -q '^arg=--remove-label$' "$GH_STUB_LOG"
    ! grep -q '^arg=--add-label$' "$GH_STUB_LOG"
}

@test "swap_label: missing args returns 2" {
    run gsm::swap_label "owner/repo" 42
    [ "$status" -eq 2 ]
    [[ "$output" == *"expected 4 args"* ]]
}

# ---- comment_issue ----

@test "comment_issue: posts to the right issue with the right body" {
    run gsm::comment_issue "owner/repo" 99 "hello world"
    [ "$status" -eq 0 ]
    grep -q '^arg=issue$' "$GH_STUB_LOG"
    grep -q '^arg=comment$' "$GH_STUB_LOG"
    grep -q '^arg=99$' "$GH_STUB_LOG"
    grep -q '^arg=hello world$' "$GH_STUB_LOG"
}

# ---- find_or_create_milestone_log_issue ----

@test "find_or_create_milestone_log_issue: returns existing issue number when found" {
    export GH_STUB_OUT_ISSUE_LIST="123"
    run gsm::find_or_create_milestone_log_issue "owner/repo" "M1"
    [ "$status" -eq 0 ]
    [ "$output" = "123" ]
    ! grep -q '^arg=create$' "$GH_STUB_LOG"
    grep -q '^arg=meta:milestone-log$' "$GH_STUB_LOG"
}

@test "find_or_create_milestone_log_issue: creates issue when missing and echoes new number" {
    export GH_STUB_OUT_ISSUE_LIST=""
    export GH_STUB_OUT_ISSUE_CREATE="https://github.com/owner/repo/issues/777"
    run gsm::find_or_create_milestone_log_issue "owner/repo" "M1"
    [ "$status" -eq 0 ]
    [ "$output" = "777" ]
    grep -q '^arg=create$' "$GH_STUB_LOG"
    grep -q '^arg=\[log\] M1$' "$GH_STUB_LOG"
    grep -q '^arg=meta:milestone-log$' "$GH_STUB_LOG"
    grep -q '^arg=--title$' "$GH_STUB_LOG"
    grep -q '^arg=--body$' "$GH_STUB_LOG"
}

# ---- append_caveman_log ----

@test "append_caveman_log: formats the comment as #N | summary | gotcha" {
    run gsm::append_caveman_log "owner/repo" 100 42 "added validator" "yq required"
    [ "$status" -eq 0 ]
    grep -q '^arg=#42 | added validator | yq required$' "$GH_STUB_LOG"
}

@test "append_caveman_log: empty gotcha is rendered as a dash" {
    run gsm::append_caveman_log "owner/repo" 100 42 "added validator" ""
    [ "$status" -eq 0 ]
    grep -q '^arg=#42 | added validator | -$' "$GH_STUB_LOG"
}

@test "append_caveman_log: gotcha argument is optional" {
    run gsm::append_caveman_log "owner/repo" 100 42 "added validator"
    [ "$status" -eq 0 ]
    grep -q '^arg=#42 | added validator | -$' "$GH_STUB_LOG"
}
