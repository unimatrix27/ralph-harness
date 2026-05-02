#!/usr/bin/env bats
#
# Tests for lib/ec2-orchestrator.sh. Slice 7 ships the discovery call:
# render the prompt, fire claude, branch on /tmp/ralph/decision.json.
# The `claude` binary is stubbed via temp-dir-on-PATH and writes canned
# output files; we assert on phase markers, OUTCOME line, exit code,
# and the rendered prompt content fed to claude on stdin.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"

    STUB_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$STUB_BIN"
    cp "${BATS_TEST_DIRNAME}/stubs/claude" "${STUB_BIN}/claude"
    chmod +x "${STUB_BIN}/claude"
    PATH="${STUB_BIN}:${PATH}"
    export PATH

    CLAUDE_STUB_LOG="${BATS_TEST_TMPDIR}/claude.log"
    CLAUDE_STUB_STDIN_CAPTURE="${BATS_TEST_TMPDIR}/claude.stdin"
    : > "$CLAUDE_STUB_LOG"
    export CLAUDE_STUB_LOG CLAUDE_STUB_STDIN_CAPTURE

    export RALPH_OUT_DIR="${BATS_TEST_TMPDIR}/out"
    export RALPH_TARGET_REPO="owner/target"
    export RALPH_AWS_REGION="eu-central-1"
    export RALPH_WORK_DIR="${BATS_TEST_TMPDIR}/work"
    export RALPH_DEFAULT_BRANCH="main"
    mkdir -p "$RALPH_WORK_DIR"

    # Discovery prompt path is fixed to the real template — we want
    # rendering to exercise it.
    export RALPH_DISCOVERY_PROMPT="${ROOT}/prompts/discovery.md"

    # No config file by default; tests that need the build/test/branch_prefix
    # substitutions populate one explicitly.
    unset RALPH_CONFIG

    # shellcheck source=../lib/ec2-orchestrator.sh
    source "${ROOT}/lib/ec2-orchestrator.sh"
}

# ---- happy path: PICKED -----------------------------------------------------

@test "discovery PICKED: emits phase markers, OUTCOME=picked, exits 0" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"PICKED","issue":42,"reasoning":"highest priority"}'
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"PHASE_START phase=discovery"* ]]
    [[ "$output" == *"PHASE_END phase=discovery duration_s="* ]]
    [[ "$output" == *"OUTCOME=picked issue=42"* ]]
}

@test "discovery PICKED without issue number returns 3" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"PICKED","reasoning":"oops"}'
    run orch::run
    [ "$status" -eq 3 ]
}

# ---- NONE / ALL_BLOCKED branches -------------------------------------------

@test "discovery NONE: emits OUTCOME=no_work, exits 0" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE","reasoning":"no candidates"}'
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"OUTCOME=no_work"* ]]
}

@test "discovery ALL_BLOCKED: emits OUTCOME=all_blocked, exits 0" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"ALL_BLOCKED","reasoning":"every candidate blocked"}'
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"OUTCOME=all_blocked"* ]]
}

@test "discovery unknown status: returns 3" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"WAT"}'
    run orch::run
    [ "$status" -eq 3 ]
}

# ---- output contract --------------------------------------------------------

@test "discovery missing decision.json: returns 3" {
    export CLAUDE_STUB_SKIP_FILE="decision.json"
    run orch::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"discovery did not write"* ]]
    [[ "$output" == *"decision.json"* ]]
}

@test "discovery missing issue.json: returns 3" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"PICKED","issue":1,"reasoning":"x"}'
    export CLAUDE_STUB_SKIP_FILE="issue.json"
    run orch::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"issue.json"* ]]
}

@test "discovery missing crafted-prompt.md: returns 3" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"PICKED","issue":1,"reasoning":"x"}'
    export CLAUDE_STUB_SKIP_FILE="crafted-prompt.md"
    run orch::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"crafted-prompt.md"* ]]
}

@test "discovery missing milestone-log.json: returns 3" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"PICKED","issue":1,"reasoning":"x"}'
    export CLAUDE_STUB_SKIP_FILE="milestone-log.json"
    run orch::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"milestone-log.json"* ]]
}

@test "discovery invalid decision json: returns 3" {
    export CLAUDE_STUB_DECISION_JSON='not json at all'
    run orch::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"not valid JSON"* ]]
}

# ---- claude failure ---------------------------------------------------------

@test "discovery claude exit non-zero: returns 1" {
    export CLAUDE_STUB_EXIT=2
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE"}'
    run orch::run
    [ "$status" -eq 1 ]
    [[ "$output" == *"claude discovery exited 2"* ]]
}

# ---- input validation -------------------------------------------------------

@test "missing RALPH_TARGET_REPO returns 2" {
    unset RALPH_TARGET_REPO
    run orch::run
    [ "$status" -eq 2 ]
    [[ "$output" == *"RALPH_TARGET_REPO"* ]]
}

# ---- prompt rendering -------------------------------------------------------

@test "rendered prompt substitutes target context" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE"}'
    run orch::run
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_STUB_STDIN_CAPTURE" ]
    grep -q '`owner/target`'  "$CLAUDE_STUB_STDIN_CAPTURE"
    grep -q '`main`'           "$CLAUDE_STUB_STDIN_CAPTURE"
    grep -q "${RALPH_WORK_DIR}" "$CLAUDE_STUB_STDIN_CAPTURE"
    # No unsubstituted placeholders should leak through.
    ! grep -q '{{RALPH_TARGET_REPO}}'   "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{RALPH_DEFAULT_BRANCH}}' "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{RALPH_WORK_DIR}}'      "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{RALPH_BUILD_CMD}}'     "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{RALPH_TEST_CMD}}'      "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{RALPH_BRANCH_PREFIX}}' "$CLAUDE_STUB_STDIN_CAPTURE"
    ! grep -q '{{PROMPT_EXTENSION}}'    "$CLAUDE_STUB_STDIN_CAPTURE"
}

@test "rendered prompt pulls build/test/branch_prefix and prompt_extensions.discovery from RALPH_CONFIG" {
    if ! command -v yq >/dev/null 2>&1; then
        skip "yq not on PATH"
    fi
    local cfg="${BATS_TEST_TMPDIR}/config.yaml"
    cat > "$cfg" <<YAML
build_cmd: "make build-x"
test_cmd: "make test-x"
branch_prefix: "ralph"
review_bot:
  username: "claude"
  source: "comment"
prompt_extensions:
  discovery: |
    EXTRA-DISCOVERY-MARKER
YAML
    export RALPH_CONFIG="$cfg"
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE"}'
    run orch::run
    [ "$status" -eq 0 ]
    grep -q 'make build-x'          "$CLAUDE_STUB_STDIN_CAPTURE"
    grep -q 'make test-x'           "$CLAUDE_STUB_STDIN_CAPTURE"
    grep -q '`ralph`'               "$CLAUDE_STUB_STDIN_CAPTURE"
    grep -q 'EXTRA-DISCOVERY-MARKER' "$CLAUDE_STUB_STDIN_CAPTURE"
}

# ---- claude invocation surface ---------------------------------------------

@test "claude is invoked with --print and a permission flag" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE"}'
    run orch::run
    [ "$status" -eq 0 ]
    grep -q '^arg=--print$' "$CLAUDE_STUB_LOG"
    grep -q '^arg=--permission-mode$' "$CLAUDE_STUB_LOG"
    grep -q '^arg=bypassPermissions$' "$CLAUDE_STUB_LOG"
}

@test "RALPH_CLAUDE_FLAGS overrides default flags" {
    export CLAUDE_STUB_DECISION_JSON='{"status":"NONE"}'
    export RALPH_CLAUDE_FLAGS="--foo --bar"
    run orch::run
    [ "$status" -eq 0 ]
    grep -q '^arg=--foo$' "$CLAUDE_STUB_LOG"
    grep -q '^arg=--bar$' "$CLAUDE_STUB_LOG"
    ! grep -q '^arg=bypassPermissions$' "$CLAUDE_STUB_LOG"
}
