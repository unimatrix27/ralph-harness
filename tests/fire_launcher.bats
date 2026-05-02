#!/usr/bin/env bats
#
# Tests for lib/fire-launcher.sh. Stubs `aws` via temp-dir-on-PATH and
# asserts on the captured invocation log + the rendered user-data /
# tag-spec / block-device-mapping. The slice's job is to prove every
# launch knob (instance type, region, IAM profile, security group,
# tagging, instance-initiated-shutdown, gp3 30GB root, no-SSH) is wired
# through correctly, plus the wall-clock backstop force-terminates.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    STUB_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$STUB_BIN"
    cp "${BATS_TEST_DIRNAME}/stubs/aws" "${STUB_BIN}/aws"
    chmod +x "${STUB_BIN}/aws"
    PATH="${STUB_BIN}:${PATH}"
    export PATH

    AWS_STUB_LOG="${BATS_TEST_TMPDIR}/aws.log"
    : > "$AWS_STUB_LOG"
    export AWS_STUB_LOG

    # Defaults: every resource discovery succeeds, run-instances returns an
    # id, describe-instances reports terminated on the first poll. Tests
    # override individual env vars to drive failure paths.
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SUBNETS="subnet-pub"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="sg-ralph"
    export AWS_STUB_OUT_SSM_GET_PARAMETER="ami-al2023"
    export AWS_STUB_OUT_EC2_RUN_INSTANCES="i-deadbeef"
    export AWS_STUB_OUT_EC2_DESCRIBE_INSTANCES="terminated"

    # shellcheck source=../lib/fire-launcher.sh
    source "${ROOT}/lib/fire-launcher.sh"
}

# ---- happy-path launch shape ----

@test "run: launches t3a.large with terminate-on-shutdown" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=run-instances$' "$AWS_STUB_LOG"
    grep -q '^arg=t3a.large$' "$AWS_STUB_LOG"
    grep -q '^arg=--instance-initiated-shutdown-behavior$' "$AWS_STUB_LOG"
    grep -q '^arg=terminate$' "$AWS_STUB_LOG"
}

@test "run: forces eu-central-1 and never any other region" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=eu-central-1$' "$AWS_STUB_LOG"
    ! grep -E '^arg=(us-|ap-|sa-|af-|me-|ca-)' "$AWS_STUB_LOG"
}

@test "run: references the bootstrapped iam profile and security group" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=Name=ralph-ec2-profile$' "$AWS_STUB_LOG"
    grep -q '^arg=sg-ralph$' "$AWS_STUB_LOG"
}

@test "run: auto-assigns a public IP in the default-AZ public subnet" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=--associate-public-ip-address$' "$AWS_STUB_LOG"
    grep -q '^arg=subnet-pub$' "$AWS_STUB_LOG"
    grep -q '^arg=Name=default-for-az,Values=true$' "$AWS_STUB_LOG"
}

@test "run: never opens any inbound SG rule" {
    run fire::run
    [ "$status" -eq 0 ]
    ! grep -q '^arg=authorize-security-group-ingress$' "$AWS_STUB_LOG"
}

@test "run: never creates or attaches an SSH key pair" {
    run fire::run
    [ "$status" -eq 0 ]
    ! grep -q '^arg=--key-name$' "$AWS_STUB_LOG"
    ! grep -q '^arg=create-key-pair$' "$AWS_STUB_LOG"
}

@test "run: requires IMDSv2 tokens" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=--metadata-options$' "$AWS_STUB_LOG"
    grep -q '^arg=HttpTokens=required' "$AWS_STUB_LOG"
}

@test "run: AMI is resolved from the public AL2023 SSM parameter" {
    run fire::run
    [ "$status" -eq 0 ]
    grep -q '^arg=get-parameter$' "$AWS_STUB_LOG"
    grep -q '^arg=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64$' "$AWS_STUB_LOG"
    grep -q '^arg=ami-al2023$' "$AWS_STUB_LOG"
}

# ---- instance / volume tags ----

@test "tag_spec: tags the instance Project=ralph + LaunchedAt + MaxLifetimeMin" {
    local tags
    tags=$(fire::__tag_spec 75)
    [[ "$tags" == *'"Project"'*'"ralph"'* ]]
    [[ "$tags" == *'"LaunchedAt"'* ]]
    [[ "$tags" == *'"MaxLifetimeMin"'*'"75"'* ]]
    [[ "$tags" == *'"ResourceType":"instance"'* ]]
    [[ "$tags" == *'"ResourceType":"volume"'* ]]
}

@test "tag_spec: launch timestamp is UTC ISO-8601" {
    local tags
    tags=$(fire::__tag_spec 75)
    # Tag list shape: {"Key":"LaunchedAt","Value":"2026-05-02T17:29:40Z"}
    printf '%s\n' "$tags" \
      | grep -E '"Key":"LaunchedAt","Value":"[0-9-]+T[0-9:]+Z"'
}

# ---- root volume ----

@test "block_device_mapping: 30 GB gp3 with delete-on-termination" {
    local bdm
    bdm=$(fire::__block_device_mapping 30)
    [[ "$bdm" == *'"VolumeType":"gp3"'* ]]
    [[ "$bdm" == *'"VolumeSize":30'* ]]
    [[ "$bdm" == *'"DeleteOnTermination":true'* ]]
}

# ---- user-data render ----

@test "render_user_data: includes phase markers + EXIT trap + shutdown" {
    local out
    out=$(fire::__render_user_data "/ralph/main")
    [[ "$out" == *'PHASE_START'* ]]
    [[ "$out" == *'PHASE_END'* ]]
    [[ "$out" == *'OUTCOME=hello'* ]]
    [[ "$out" == *'trap'*'EXIT'* ]]
    [[ "$out" == *'shutdown -h now'* ]]
    [[ "$out" == *'/ralph/main'* ]]
}

@test "render_user_data: exactly one shebang at the top of the rendered script" {
    local out
    out=$(fire::__render_user_data "/ralph/main")
    [[ "$(printf '%s\n' "$out" | head -n 1)" == '#!/bin/bash' ]]
    [ "$(printf '%s\n' "$out" | grep -c '^#!')" -eq 1 ]
}

@test "render_user_data: passes through a custom log group" {
    local out
    out=$(fire::__render_user_data "/some/other-group")
    [[ "$out" == *'/some/other-group'* ]]
}

@test "render_user_data: cloud-init does not need ssh, jq, or static creds" {
    local out
    out=$(fire::__render_user_data "/ralph/main")
    ! [[ "$out" == *'ANTHROPIC_API_KEY'* ]]
    ! [[ "$out" == *'authorized_keys'* ]]
}

# ---- pre-flight failures ----

@test "run: refuses when no default VPC" {
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="None"
    run fire::run
    [ "$status" -eq 2 ]
    [[ "$output" == *"no default VPC"* ]]
    ! grep -q '^arg=run-instances$' "$AWS_STUB_LOG"
}

@test "run: refuses when the security group is not bootstrapped" {
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="None"
    run fire::run
    [ "$status" -eq 2 ]
    [[ "$output" == *"security group"* ]]
    [[ "$output" == *"bootstrap"* ]]
    ! grep -q '^arg=run-instances$' "$AWS_STUB_LOG"
}

@test "run: refuses when no default-AZ subnet" {
    export AWS_STUB_OUT_EC2_DESCRIBE_SUBNETS="None"
    run fire::run
    [ "$status" -eq 2 ]
    [[ "$output" == *"no default subnet"* ]]
    ! grep -q '^arg=run-instances$' "$AWS_STUB_LOG"
}

@test "run: refuses when AL2023 AMI does not resolve" {
    export AWS_STUB_OUT_SSM_GET_PARAMETER="None"
    run fire::run
    [ "$status" -eq 2 ]
    [[ "$output" == *"AL2023 image"* ]]
    ! grep -q '^arg=run-instances$' "$AWS_STUB_LOG"
}

# ---- wall-clock backstop ----

@test "wait_for_terminated: returns 0 when state is terminated" {
    export AWS_STUB_OUT_EC2_DESCRIBE_INSTANCES="terminated"
    FIRE_POLL_INTERVAL_SEC=0
    FIRE_MAX_LIFETIME_MIN=1
    run fire::__wait_for_terminated "i-x"
    [ "$status" -eq 0 ]
}

@test "wait_for_terminated: ceiling breach forces terminate-instances and returns 3" {
    export AWS_STUB_OUT_EC2_DESCRIBE_INSTANCES="running"
    FIRE_POLL_INTERVAL_SEC=0
    FIRE_MAX_LIFETIME_MIN=0
    run fire::__wait_for_terminated "i-stuck"
    [ "$status" -eq 3 ]
    [[ "$output" == *"breached"* ]]
    grep -q '^arg=terminate-instances$' "$AWS_STUB_LOG"
    grep -q '^arg=i-stuck$' "$AWS_STUB_LOG"
}
