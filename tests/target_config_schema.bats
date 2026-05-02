#!/usr/bin/env bats
#
# Tests for lib/target-config-schema.sh via the bin/load-config CLI.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    LOAD="${ROOT}/bin/load-config"
    FIX="${ROOT}/tests/fixtures"
}

@test "valid full config exits 0" {
    run "$LOAD" "$FIX/valid-full.yaml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok:"* ]]
}

@test "valid minimal config exits 0" {
    run "$LOAD" "$FIX/valid-minimal.yaml"
    [ "$status" -eq 0 ]
}

@test "missing required field reports the missing key" {
    run "$LOAD" "$FIX/missing-required.yaml"
    [ "$status" -eq 4 ]
    [[ "$output" == *"missing required field"* ]]
    [[ "$output" == *"build_cmd"* ]]
}

@test "malformed yaml reports a parse error" {
    run "$LOAD" "$FIX/malformed.yaml"
    [ "$status" -eq 3 ]
    [[ "$output" == *"malformed yaml"* ]]
}

@test "unknown top-level field is rejected" {
    run "$LOAD" "$FIX/unknown-field.yaml"
    [ "$status" -eq 5 ]
    [[ "$output" == *"unknown field"* ]]
    [[ "$output" == *"unexpected_key"* ]]
}

@test "wrong type for required field is rejected" {
    run "$LOAD" "$FIX/wrong-type.yaml"
    [ "$status" -eq 6 ]
    [[ "$output" == *"build_cmd"* ]]
    [[ "$output" == *"must be a string"* ]]
}

@test "missing file is rejected with a readable error" {
    run "$LOAD" "$FIX/does-not-exist.yaml"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not found"* ]]
}

@test "no argument prints usage" {
    run "$LOAD"
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]]
}
