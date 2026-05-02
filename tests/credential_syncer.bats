#!/usr/bin/env bats
#
# Tests for lib/credential-syncer.sh. Stubs `aws` and `security` via
# temp-dir-on-PATH and asserts on captured invocation logs.
#
# Most tests cover three things:
#   1. Happy-path upload calls put-parameter with --cli-input-json.
#   2. Failure modes (missing Keychain entry, bad JSON, no AWS creds) exit
#      with documented codes and a useful stderr message.
#   3. The credential value never appears in any argv recorded by the stubs,
#      and never appears in stdout/stderr of the syncer itself.

MARKER='MARKER_CREDENTIAL_DO_NOT_LEAK_ABCDEF1234567890'

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    STUB_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$STUB_BIN"
    cp "${BATS_TEST_DIRNAME}/stubs/aws"      "${STUB_BIN}/aws"
    cp "${BATS_TEST_DIRNAME}/stubs/security" "${STUB_BIN}/security"
    chmod +x "${STUB_BIN}/aws" "${STUB_BIN}/security"
    PATH="${STUB_BIN}:${PATH}"
    export PATH

    AWS_STUB_LOG="${BATS_TEST_TMPDIR}/aws.log"
    SECURITY_STUB_LOG="${BATS_TEST_TMPDIR}/security.log"
    : > "$AWS_STUB_LOG"
    : > "$SECURITY_STUB_LOG"
    export AWS_STUB_LOG SECURITY_STUB_LOG

    # Default: AWS auth check succeeds, Keychain returns a valid JSON
    # credential containing the marker so tests can assert non-leakage.
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_STS_GET_CALLER_IDENTITY=0
    export SECURITY_STUB_OUT='{"claudeAiOauth":{"accessToken":"'"$MARKER"'","refreshToken":"r","expiresAt":1,"scopes":["a"],"subscriptionType":"x"}}'

    # shellcheck source=../lib/credential-syncer.sh
    source "${ROOT}/lib/credential-syncer.sh"
}

# ---- happy path ----

@test "run: uploads credential via --cli-input-json on the default key" {
    run credsync::run
    [ "$status" -eq 0 ]
    grep -q '^arg=ssm$'                 "$AWS_STUB_LOG"
    grep -q '^arg=put-parameter$'       "$AWS_STUB_LOG"
    grep -q '^arg=--cli-input-json$'    "$AWS_STUB_LOG"
    # the default key is mentioned in the info line
    [[ "$output" == *"/ralph/claude-oauth-credential"* ]]
}

@test "run: uses eu-central-1 as the region" {
    run credsync::run
    [ "$status" -eq 0 ]
    grep -q '^arg=eu-central-1$' "$AWS_STUB_LOG"
    ! grep -E '^arg=(us-|ap-|sa-|af-|me-)' "$AWS_STUB_LOG"
}

@test "run: honors RALPH_CLAUDE_OAUTH_SSM_KEY override" {
    export RALPH_CLAUDE_OAUTH_SSM_KEY="/ralph/custom-key"
    run credsync::run
    [ "$status" -eq 0 ]
    [[ "$output" == *"/ralph/custom-key"* ]]
}

@test "run: honors positional ssm-key argument over env" {
    export RALPH_CLAUDE_OAUTH_SSM_KEY="/ralph/from-env"
    run credsync::run "/ralph/from-arg"
    [ "$status" -eq 0 ]
    [[ "$output" == *"/ralph/from-arg"* ]]
    [[ "$output" != *"/ralph/from-env"* ]]
}

@test "run: never passes --value or the credential on any aws argv" {
    run credsync::run
    [ "$status" -eq 0 ]
    ! grep -q '^arg=--value$' "$AWS_STUB_LOG"
    # the credential bytes must never reach any aws argv
    ! grep -q "$MARKER" "$AWS_STUB_LOG"
}

@test "run: never echoes the credential to stdout or stderr" {
    run credsync::run
    [ "$status" -eq 0 ]
    [[ "$output" != *"$MARKER"* ]]
}

@test "run: cleans up the temp request-body file on success" {
    run credsync::run
    [ "$status" -eq 0 ]
    # the syncer makes its temp file under $TMPDIR with the prefix
    # "ralph-credsync"; ensure none survive the run
    ! find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'ralph-credsync*' -print0 \
        | grep -qz .
}

# ---- failure modes ----

@test "run: exits 4 when AWS credentials are not configured" {
    export AWS_STUB_EXIT_STS_GET_CALLER_IDENTITY=1
    run credsync::run
    [ "$status" -eq 4 ]
    [[ "$output" == *"AWS credentials not configured"* ]]
    ! grep -q '^arg=put-parameter$' "$AWS_STUB_LOG"
}

@test "run: exits 3 when the Keychain entry is missing" {
    export SECURITY_STUB_EXIT=1
    export SECURITY_STUB_OUT=""
    run credsync::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"not found"* ]]
    ! grep -q '^arg=put-parameter$' "$AWS_STUB_LOG"
}

@test "run: exits 3 when the Keychain entry is empty" {
    export SECURITY_STUB_EXIT=0
    export SECURITY_STUB_OUT=""
    run credsync::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"empty"* ]]
    ! grep -q '^arg=put-parameter$' "$AWS_STUB_LOG"
}

@test "run: exits 3 when the Keychain entry is not valid JSON" {
    export SECURITY_STUB_OUT="this-is-not-json"
    run credsync::run
    [ "$status" -eq 3 ]
    [[ "$output" == *"not valid JSON"* ]]
    ! grep -q '^arg=put-parameter$' "$AWS_STUB_LOG"
    # error message must not include the bogus credential bytes
    [[ "$output" != *"this-is-not-json"* ]]
}

@test "run: queries the configured Keychain service name" {
    run credsync::run
    [ "$status" -eq 0 ]
    grep -q '^arg=Claude Code-credentials$' "$SECURITY_STUB_LOG"
    grep -q '^arg=-w$' "$SECURITY_STUB_LOG"
}
