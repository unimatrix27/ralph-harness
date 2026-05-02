# shellcheck shell=bash
#
# ec2-orchestrator.sh — entry point for the three-call flow on a freshly
# bootstrapped EC2 instance. Slice 6 ships only the stub: `orch::run`
# emits phase markers and `OUTCOME=ready`, then returns. Subsequent
# slices (#8 discovery, #9 implementation, #10 review) replace this with
# the real claude invocations.
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
# Library file. Do not set strict shell options here (would affect callers).

orch::__info() {
    printf 'ec2-orchestrator: %s\n' "$*"
}

orch::__now() {
    date -u +%FT%TZ 2>/dev/null || date -u
}

# orch::run
#
# Slice 6 stub: prove the box reached the post-bootstrap state where a
# real claude call would succeed, log unambiguous markers, and return.
# Never opens a network call, never mutates the target.
orch::run() {
    local now
    now=$(orch::__now)
    echo "PHASE_START phase=ready ts=${now} target=${RALPH_TARGET_REPO:-unknown}"
    orch::__info "ralph-harness slice 6 stub orchestrator"
    orch::__info "deps installed, secrets fetched, target cloned, config validated"
    orch::__info "work_dir=${RALPH_WORK_DIR:-} default_branch=${RALPH_DEFAULT_BRANCH:-} config=${RALPH_CONFIG:-}"
    echo "PHASE_END phase=ready ts=$(orch::__now)"
    echo "OUTCOME=ready"
}
