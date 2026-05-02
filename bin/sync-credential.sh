#!/usr/bin/env bash
#
# sync-credential.sh — extracts the macOS Keychain `Claude Code-credentials`
# entry and writes it into SSM as a SecureString. Re-run after every
# desktop `claude /login`.
#
# Usage:
#   bin/sync-credential.sh [<ssm-key>]
#
# Reads from env:
#   RALPH_CLAUDE_OAUTH_SSM_KEY    SSM parameter name
#                                 (default /ralph/claude-oauth-credential)
#
# Region is forced to eu-central-1 (matching bin/bootstrap-aws.sh). The
# credential is never echoed, logged, or placed on any process's argv.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/credential-syncer.sh
source "${HERE}/lib/credential-syncer.sh"

credsync::run "$@"
