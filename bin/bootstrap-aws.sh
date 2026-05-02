#!/usr/bin/env bash
#
# bootstrap-aws.sh — idempotent first-run bootstrap of the AWS-side and
# target-side resources the ralph-harness needs.
#
# Reads from env:
#   RALPH_TARGET_REPO              required (owner/repo)
#   RALPH_GITHUB_TOKEN_SSM_KEY     defaults to /ralph/github-pat
#   RALPH_CLAUDE_OAUTH_SSM_KEY     defaults to /ralph/claude-oauth-credential
#   RALPH_LOG_GROUP                defaults to /ralph/main
#
# Region is forced to eu-central-1.
#
# Re-running on an already-bootstrapped account is a clean no-op.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/aws-bootstrap.sh
source "${HERE}/lib/aws-bootstrap.sh"

awsbs::run_all
