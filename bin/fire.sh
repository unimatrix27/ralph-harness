#!/usr/bin/env bash
#
# fire.sh — slice 5 launcher. Fires one throwaway EC2 instance with the
# hello-world cloud-init payload, then polls for instance-terminated with a
# 75-minute ceiling. Force-terminates on breach.
#
# Reads from env (with overridable defaults — see lib/fire-launcher.sh):
#   RALPH_AWS_REGION         (default eu-central-1)
#   RALPH_LOG_GROUP          (default /ralph/main)
#   RALPH_SG_NAME            (default ralph-sg)
#   RALPH_IAM_PROFILE        (default ralph-ec2-profile)
#   RALPH_MAX_LIFETIME_MIN   (default 75)
#
# Auto-bootstrap:
#   By default fire.sh subprocesses `ralph-bootstrap-aws` first (the slice-4
#   TS port of the old `lib/aws-bootstrap.sh` module). Same idempotent
#   resource set: ~2-3s of describe/list calls on an already-bootstrapped
#   account, plus a one-time gh-label-create on a new target repo.
#
#   Resolution order: the globally-installed bin (after `npm install -g
#   @unimatrix27/ralph-harness`) is preferred; otherwise we fall back to
#   the local checkout's `dist/bin/ralph-bootstrap-aws.js`, which requires
#   `npm run build` to have been run at least once.
#
#   Set RALPH_SKIP_BOOTSTRAP=1 when running with fire-only IAM perms or
#   when you want to keep CloudTrail volume minimal.
#
# Exit codes: see lib/fire-launcher.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/fire-launcher.sh
source "${HERE}/lib/fire-launcher.sh"

if [[ "${RALPH_SKIP_BOOTSTRAP:-0}" != "1" ]]; then
    if command -v ralph-bootstrap-aws >/dev/null 2>&1; then
        ralph-bootstrap-aws || exit $?
    elif [[ -f "${HERE}/dist/bin/ralph-bootstrap-aws.js" ]]; then
        node "${HERE}/dist/bin/ralph-bootstrap-aws.js" || exit $?
    else
        printf 'fire: ralph-bootstrap-aws not found on PATH and dist/bin/ralph-bootstrap-aws.js is missing.\n' >&2
        printf 'fire: install the package globally (npm install -g @unimatrix27/ralph-harness) or run `npm run build` from the checkout root.\n' >&2
        exit 2
    fi
fi

fire::run "$@"
