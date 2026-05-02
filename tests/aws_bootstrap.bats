#!/usr/bin/env bats
#
# Tests for lib/aws-bootstrap.sh. Stubs `aws` and `gh` via temp-dir-on-PATH
# and asserts on the captured invocation log. Most tests cover the
# first-run-creates / second-run-skips contract that defines idempotency.

setup() {
    ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
    STUB_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$STUB_BIN"
    cp "${BATS_TEST_DIRNAME}/stubs/aws" "${STUB_BIN}/aws"
    cp "${BATS_TEST_DIRNAME}/stubs/gh"  "${STUB_BIN}/gh"
    chmod +x "${STUB_BIN}/aws" "${STUB_BIN}/gh"
    PATH="${STUB_BIN}:${PATH}"
    export PATH

    AWS_STUB_LOG="${BATS_TEST_TMPDIR}/aws.log"
    GH_STUB_LOG="${BATS_TEST_TMPDIR}/gh.log"
    : > "$AWS_STUB_LOG"
    : > "$GH_STUB_LOG"
    export AWS_STUB_LOG GH_STUB_LOG

    # shellcheck source=../lib/aws-bootstrap.sh
    source "${ROOT}/lib/aws-bootstrap.sh"
}

# ---- ensure_kms_alias ----

@test "ensure_kms_alias: creates key and alias on first run" {
    export AWS_STUB_EXIT_KMS_DESCRIBE_KEY=1
    export AWS_STUB_OUT_KMS_CREATE_KEY="abcd-1234"
    run awsbs::ensure_kms_alias "alias/ralph"
    [ "$status" -eq 0 ]
    grep -q '^arg=create-key$'   "$AWS_STUB_LOG"
    grep -q '^arg=create-alias$' "$AWS_STUB_LOG"
    grep -q '^arg=alias/ralph$'  "$AWS_STUB_LOG"
}

@test "ensure_kms_alias: skips creation when alias resolves" {
    export AWS_STUB_EXIT_KMS_DESCRIBE_KEY=0
    run awsbs::ensure_kms_alias "alias/ralph"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create-key$'   "$AWS_STUB_LOG"
    ! grep -q '^arg=create-alias$' "$AWS_STUB_LOG"
}

# ---- ensure_ssm_securestring ----

@test "ensure_ssm_securestring: puts SecureString with --no-overwrite on first run" {
    export AWS_STUB_EXIT_SSM_GET_PARAMETER=1
    run awsbs::ensure_ssm_securestring "/ralph/github-pat" "desc" "alias/ralph"
    [ "$status" -eq 0 ]
    grep -q '^arg=put-parameter$'  "$AWS_STUB_LOG"
    grep -q '^arg=SecureString$'   "$AWS_STUB_LOG"
    grep -q '^arg=alias/ralph$'    "$AWS_STUB_LOG"
    grep -q '^arg=--no-overwrite$' "$AWS_STUB_LOG"
}

@test "ensure_ssm_securestring: skips when parameter already exists" {
    export AWS_STUB_EXIT_SSM_GET_PARAMETER=0
    run awsbs::ensure_ssm_securestring "/ralph/github-pat" "desc" "alias/ralph"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=put-parameter$' "$AWS_STUB_LOG"
}

# ---- ensure_log_group ----

@test "ensure_log_group: creates when missing" {
    export AWS_STUB_OUT_LOGS_DESCRIBE_LOG_GROUPS=""
    run awsbs::ensure_log_group "/ralph/main"
    [ "$status" -eq 0 ]
    grep -q '^arg=create-log-group$' "$AWS_STUB_LOG"
}

@test "ensure_log_group: skips when log group already present" {
    export AWS_STUB_OUT_LOGS_DESCRIBE_LOG_GROUPS="/ralph/main"
    run awsbs::ensure_log_group "/ralph/main"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create-log-group$' "$AWS_STUB_LOG"
}

# ---- ensure_security_group ----

@test "ensure_security_group: creates in default VPC, no inbound rules added" {
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="None"
    export AWS_STUB_OUT_EC2_CREATE_SECURITY_GROUP="sg-abcd"
    run awsbs::ensure_security_group "ralph-sg" "ralph-harness EC2 worker"
    [ "$status" -eq 0 ]
    grep -q '^arg=create-security-group$' "$AWS_STUB_LOG"
    # never opens any inbound rule
    ! grep -q '^arg=authorize-security-group-ingress$' "$AWS_STUB_LOG"
}

@test "ensure_security_group: skips when group already exists in default VPC" {
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="sg-existing"
    run awsbs::ensure_security_group "ralph-sg" "ralph-harness EC2 worker"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create-security-group$' "$AWS_STUB_LOG"
}

@test "ensure_security_group: errors out cleanly when no default VPC" {
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="None"
    run awsbs::ensure_security_group "ralph-sg" "desc"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no default VPC"* ]]
}

# ---- ensure_iam_role_and_profile ----

@test "ensure_iam_role_and_profile: creates role, profile, attaches policy + inline doc on first run" {
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_IAM_GET_ROLE=1
    export AWS_STUB_OUT_IAM_LIST_ATTACHED_ROLE_POLICIES=""
    export AWS_STUB_EXIT_IAM_GET_ROLE_POLICY=1
    export AWS_STUB_EXIT_IAM_GET_INSTANCE_PROFILE=1
    run awsbs::ensure_iam_role_and_profile \
        "ralph-ec2-role" "ralph-ec2-profile" \
        "/ralph/github-pat" "/ralph/claude-oauth-credential" \
        "/ralph/main" "alias/ralph"
    [ "$status" -eq 0 ]
    grep -q '^arg=create-role$'                    "$AWS_STUB_LOG"
    grep -q '^arg=attach-role-policy$'             "$AWS_STUB_LOG"
    grep -q '^arg=put-role-policy$'                "$AWS_STUB_LOG"
    grep -q '^arg=create-instance-profile$'        "$AWS_STUB_LOG"
    grep -q '^arg=add-role-to-instance-profile$'   "$AWS_STUB_LOG"
    grep -q '^arg=AmazonSSMManagedInstanceCore$'   "$AWS_STUB_LOG" \
        || grep -q '^arg=arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore$' "$AWS_STUB_LOG"
}

@test "ensure_iam_role_and_profile: idempotent when everything already matches" {
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_IAM_GET_ROLE=0
    export AWS_STUB_OUT_IAM_LIST_ATTACHED_ROLE_POLICIES="AmazonSSMManagedInstanceCore"
    # Reuse the module's own helper to compute the exact policy doc the
    # function expects to compare against.
    local doc
    doc=$(awsbs::__inline_policy_doc "123456789012" "/ralph/github-pat" "/ralph/claude-oauth-credential" "/ralph/main" "alias/ralph")
    export AWS_STUB_OUT_IAM_GET_ROLE_POLICY="$doc"
    export AWS_STUB_EXIT_IAM_GET_ROLE_POLICY=0
    export AWS_STUB_EXIT_IAM_GET_INSTANCE_PROFILE=0
    export AWS_STUB_OUT_IAM_GET_INSTANCE_PROFILE="ralph-ec2-role"
    run awsbs::ensure_iam_role_and_profile \
        "ralph-ec2-role" "ralph-ec2-profile" \
        "/ralph/github-pat" "/ralph/claude-oauth-credential" \
        "/ralph/main" "alias/ralph"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create-role$'                  "$AWS_STUB_LOG"
    ! grep -q '^arg=attach-role-policy$'           "$AWS_STUB_LOG"
    ! grep -q '^arg=put-role-policy$'              "$AWS_STUB_LOG"
    ! grep -q '^arg=create-instance-profile$'      "$AWS_STUB_LOG"
    ! grep -q '^arg=add-role-to-instance-profile$' "$AWS_STUB_LOG"
}

# ---- ensure_agent_stuck_label ----

@test "ensure_agent_stuck_label: creates when missing on the target repo" {
    export GH_STUB_OUT_LABEL_LIST=""
    run awsbs::ensure_agent_stuck_label "owner/repo" "agent-stuck"
    [ "$status" -eq 0 ]
    grep -q '^arg=label$'        "$GH_STUB_LOG"
    grep -q '^arg=create$'       "$GH_STUB_LOG"
    grep -q '^arg=agent-stuck$'  "$GH_STUB_LOG"
}

@test "ensure_agent_stuck_label: skips when label already present" {
    export GH_STUB_OUT_LABEL_LIST=$'bug\nagent-stuck\nready-for-agent'
    run awsbs::ensure_agent_stuck_label "owner/repo" "agent-stuck"
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create$' "$GH_STUB_LOG"
}

# ---- run_all ----

@test "run_all: refuses to start without RALPH_TARGET_REPO" {
    unset RALPH_TARGET_REPO
    run awsbs::run_all
    [ "$status" -eq 2 ]
    [[ "$output" == *"RALPH_TARGET_REPO is required"* ]]
}

@test "run_all: first run creates every resource (one of each)" {
    export RALPH_TARGET_REPO="owner/repo"
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_KMS_DESCRIBE_KEY=1
    export AWS_STUB_OUT_KMS_CREATE_KEY="abcd-1234"
    export AWS_STUB_EXIT_SSM_GET_PARAMETER=1
    export AWS_STUB_OUT_LOGS_DESCRIBE_LOG_GROUPS=""
    export AWS_STUB_EXIT_IAM_GET_ROLE=1
    export AWS_STUB_OUT_IAM_LIST_ATTACHED_ROLE_POLICIES=""
    export AWS_STUB_EXIT_IAM_GET_ROLE_POLICY=1
    export AWS_STUB_EXIT_IAM_GET_INSTANCE_PROFILE=1
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="None"
    export AWS_STUB_OUT_EC2_CREATE_SECURITY_GROUP="sg-abcd"
    export GH_STUB_OUT_LABEL_LIST=""
    run awsbs::run_all
    [ "$status" -eq 0 ]
    # one of every create call
    [ "$(grep -c '^arg=create-key$'                  "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=create-alias$'                "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=put-parameter$'               "$AWS_STUB_LOG")" -eq 2 ]
    [ "$(grep -c '^arg=create-log-group$'            "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=create-role$'                 "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=attach-role-policy$'          "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=put-role-policy$'             "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=create-instance-profile$'     "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=add-role-to-instance-profile$' "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=create-security-group$'       "$AWS_STUB_LOG")" -eq 1 ]
    [ "$(grep -c '^arg=create$'                      "$GH_STUB_LOG")"  -eq 1 ]
}

@test "run_all: second run on a bootstrapped account is a clean no-op" {
    export RALPH_TARGET_REPO="owner/repo"
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_KMS_DESCRIBE_KEY=0
    export AWS_STUB_EXIT_SSM_GET_PARAMETER=0
    export AWS_STUB_OUT_LOGS_DESCRIBE_LOG_GROUPS="/ralph/main"
    export AWS_STUB_EXIT_IAM_GET_ROLE=0
    export AWS_STUB_OUT_IAM_LIST_ATTACHED_ROLE_POLICIES="AmazonSSMManagedInstanceCore"
    local doc
    doc=$(awsbs::__inline_policy_doc "123456789012" "/ralph/github-pat" "/ralph/claude-oauth-credential" "/ralph/main" "alias/ralph")
    export AWS_STUB_OUT_IAM_GET_ROLE_POLICY="$doc"
    export AWS_STUB_EXIT_IAM_GET_ROLE_POLICY=0
    export AWS_STUB_EXIT_IAM_GET_INSTANCE_PROFILE=0
    export AWS_STUB_OUT_IAM_GET_INSTANCE_PROFILE="ralph-ec2-role"
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="sg-existing"
    export GH_STUB_OUT_LABEL_LIST=$'agent-stuck\nbug'
    run awsbs::run_all
    [ "$status" -eq 0 ]
    ! grep -q '^arg=create-key$'                   "$AWS_STUB_LOG"
    ! grep -q '^arg=create-alias$'                 "$AWS_STUB_LOG"
    ! grep -q '^arg=put-parameter$'                "$AWS_STUB_LOG"
    ! grep -q '^arg=create-log-group$'             "$AWS_STUB_LOG"
    ! grep -q '^arg=create-role$'                  "$AWS_STUB_LOG"
    ! grep -q '^arg=attach-role-policy$'           "$AWS_STUB_LOG"
    ! grep -q '^arg=put-role-policy$'              "$AWS_STUB_LOG"
    ! grep -q '^arg=create-instance-profile$'      "$AWS_STUB_LOG"
    ! grep -q '^arg=add-role-to-instance-profile$' "$AWS_STUB_LOG"
    ! grep -q '^arg=create-security-group$'        "$AWS_STUB_LOG"
    ! grep -q '^arg=create$'                       "$GH_STUB_LOG"
}

@test "run_all: uses eu-central-1 as the region" {
    export RALPH_TARGET_REPO="owner/repo"
    export AWS_STUB_OUT_STS_GET_CALLER_IDENTITY="123456789012"
    export AWS_STUB_EXIT_KMS_DESCRIBE_KEY=0
    export AWS_STUB_EXIT_SSM_GET_PARAMETER=0
    export AWS_STUB_OUT_LOGS_DESCRIBE_LOG_GROUPS="/ralph/main"
    export AWS_STUB_EXIT_IAM_GET_ROLE=0
    export AWS_STUB_OUT_IAM_LIST_ATTACHED_ROLE_POLICIES="AmazonSSMManagedInstanceCore"
    local doc
    doc=$(awsbs::__inline_policy_doc "123456789012" "/ralph/github-pat" "/ralph/claude-oauth-credential" "/ralph/main" "alias/ralph")
    export AWS_STUB_OUT_IAM_GET_ROLE_POLICY="$doc"
    export AWS_STUB_EXIT_IAM_GET_ROLE_POLICY=0
    export AWS_STUB_EXIT_IAM_GET_INSTANCE_PROFILE=0
    export AWS_STUB_OUT_IAM_GET_INSTANCE_PROFILE="ralph-ec2-role"
    export AWS_STUB_OUT_EC2_DESCRIBE_VPCS="vpc-default"
    export AWS_STUB_OUT_EC2_DESCRIBE_SECURITY_GROUPS="sg-existing"
    export GH_STUB_OUT_LABEL_LIST="agent-stuck"
    run awsbs::run_all
    [ "$status" -eq 0 ]
    grep -q '^arg=eu-central-1$' "$AWS_STUB_LOG"
    # never targets any other region during the run
    ! grep -E '^arg=(us-|ap-|sa-|af-|me-)' "$AWS_STUB_LOG"
}
