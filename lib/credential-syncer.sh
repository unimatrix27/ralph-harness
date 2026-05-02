# shellcheck shell=bash
#
# credential-syncer.sh — extracts the macOS Keychain `Claude Code-credentials`
# entry and writes it into the SSM SecureString that the EC2 worker reads at
# launch. Re-run after every desktop `claude /login`.
#
# Public surface:
#   credsync::run [<ssm-key>]
#
# Reads from env (with overridable defaults):
#   RALPH_CLAUDE_OAUTH_SSM_KEY    SSM parameter name
#                                 (default /ralph/claude-oauth-credential)
#   CREDSYNC_REGION               AWS region (default eu-central-1, matching
#                                 aws-bootstrap)
#   CREDSYNC_KMS_ALIAS            KMS alias for SecureString encryption
#                                 (default alias/ralph)
#   CREDSYNC_KEYCHAIN_SERVICE     Keychain service name
#                                 (default 'Claude Code-credentials')
#
# Exit codes:
#   0   success
#   2   usage error
#   3   Keychain entry missing, empty, or not JSON
#   4   AWS credentials not configured
#   non-zero   propagated from `aws` or `security`
#
# Security:
#   - The credential is read once into a single shell variable, then passed
#     to `aws` via a `--cli-input-json file://...` request body in a temp
#     file with mode 0600. It is never exposed on any argv.
#   - The credential is piped into `jq` on stdin, so it does not appear on
#     jq's argv either.
#   - The temp file is removed via trap on EXIT/INT/TERM.
#   - No info/error message ever includes the credential value.
#
# Dependencies: macOS `security` CLI, aws CLI v2 (authenticated), jq.
#
# Library file. Do not set strict shell options here (would affect callers).

CREDSYNC_REGION="${CREDSYNC_REGION:-eu-central-1}"
CREDSYNC_KMS_ALIAS="${CREDSYNC_KMS_ALIAS:-alias/ralph}"
CREDSYNC_KEYCHAIN_SERVICE="${CREDSYNC_KEYCHAIN_SERVICE:-Claude Code-credentials}"

credsync::__err() {
    printf 'credential-syncer: error: %s\n' "$*" >&2
}

credsync::__info() {
    printf 'credential-syncer: %s\n' "$*"
}

credsync::__aws() {
    aws --region "$CREDSYNC_REGION" "$@"
}

# credsync::__read_keychain
#
# Echoes the credential bytes to stdout. Returns 3 on missing/empty entry.
credsync::__read_keychain() {
    local out
    if ! out=$(security find-generic-password -s "$CREDSYNC_KEYCHAIN_SERVICE" -w 2>/dev/null); then
        credsync::__err "Keychain entry '${CREDSYNC_KEYCHAIN_SERVICE}' not found. Log into the Claude desktop app first (claude /login)."
        return 3
    fi
    if [[ -z "$out" ]]; then
        credsync::__err "Keychain entry '${CREDSYNC_KEYCHAIN_SERVICE}' is empty."
        return 3
    fi
    printf '%s' "$out"
}

# credsync::__check_aws
#
# Confirms AWS credentials are configured for the active region. Returns 4
# on failure.
credsync::__check_aws() {
    if ! credsync::__aws sts get-caller-identity >/dev/null 2>&1; then
        credsync::__err "AWS credentials not configured for region ${CREDSYNC_REGION}. Run 'aws configure' or set AWS_PROFILE."
        return 4
    fi
}

# credsync::run [<ssm-key>]
#
# Reads the Keychain entry, validates it parses as JSON, and uploads it to
# the SSM SecureString at <ssm-key>. Always uses --overwrite because the
# parameter is created with a placeholder by aws-bootstrap and must be
# updated in place.
credsync::run() {
    local key="${1:-${RALPH_CLAUDE_OAUTH_SSM_KEY:-/ralph/claude-oauth-credential}}"

    credsync::__check_aws || return $?

    local cred
    cred=$(credsync::__read_keychain) || return $?

    if ! printf '%s' "$cred" | jq -e . >/dev/null 2>&1; then
        credsync::__err "Keychain entry '${CREDSYNC_KEYCHAIN_SERVICE}' is not valid JSON. Re-login via the Claude desktop app and retry."
        return 3
    fi

    local tmp
    tmp=$(mktemp -t ralph-credsync) || return $?
    chmod 600 "$tmp"
    # shellcheck disable=SC2064
    trap "rm -f '$tmp'" EXIT INT TERM

    if ! printf '%s' "$cred" | jq -Rs \
        --arg name "$key" \
        --arg type SecureString \
        --arg keyId "$CREDSYNC_KMS_ALIAS" \
        '{Name: $name, Type: $type, KeyId: $keyId, Value: ., Overwrite: true}' \
        > "$tmp"; then
        credsync::__err "failed to build SSM put-parameter request body"
        return 1
    fi

    credsync::__info "uploading credential to ${key} (region=${CREDSYNC_REGION}, kms=${CREDSYNC_KMS_ALIAS})"

    if ! credsync::__aws ssm put-parameter --cli-input-json "file://${tmp}" >/dev/null; then
        credsync::__err "ssm put-parameter failed for ${key}"
        return 1
    fi

    credsync::__info "uploaded credential to ${key}"
}
