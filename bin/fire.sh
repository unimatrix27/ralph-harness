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
#   By default fire.sh calls `awsbs::run_all` first. This is the same
#   idempotent setup `bin/bootstrap-aws.sh` runs (~2-3s of describe/list
#   calls on an already-bootstrapped account, plus a one-time
#   gh-label-create on a new target repo). Removes the manual "run
#   bootstrap once when switching target" step.
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
    # shellcheck source=../lib/aws-bootstrap.sh
    source "${HERE}/lib/aws-bootstrap.sh"
    awsbs::run_all || exit $?
fi

fire::run "$@"
