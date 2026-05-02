#!/usr/bin/env bats
#
# Tests for lib/ec2-orchestrator.sh. Slice 6 ships the stub only:
# `orch::run` must emit the three log markers the CloudWatch-side log
# scrapers grep for.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    # shellcheck source=../lib/ec2-orchestrator.sh
    source "${ROOT}/lib/ec2-orchestrator.sh"

    export RALPH_TARGET_REPO="owner/target"
    export RALPH_AWS_REGION="eu-central-1"
    export RALPH_WORK_DIR="/tmp/ralph-work-test"
    export RALPH_DEFAULT_BRANCH="main"
    export RALPH_CONFIG="${RALPH_WORK_DIR}/.ralph/config.yaml"
}

@test "run: emits PHASE_START phase=ready" {
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"PHASE_START phase=ready"* ]]
}

@test "run: emits PHASE_END phase=ready" {
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"PHASE_END phase=ready"* ]]
}

@test "run: emits OUTCOME=ready" {
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"OUTCOME=ready"* ]]
}

@test "run: surfaces target repo and bootstrap-set state" {
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"target=owner/target"* ]]
    [[ "$output" == *"work_dir=/tmp/ralph-work-test"* ]]
    [[ "$output" == *"default_branch=main"* ]]
}

@test "run: tolerates missing target context (no claude calls in stub)" {
    unset RALPH_TARGET_REPO RALPH_WORK_DIR RALPH_DEFAULT_BRANCH RALPH_CONFIG
    run orch::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"OUTCOME=ready"* ]]
}
