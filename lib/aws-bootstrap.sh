# shellcheck shell=bash
#
# aws-bootstrap.sh — idempotent AWS-side and target-side bootstrap for the
# ralph-harness. Public functions ensure each resource exists; re-running
# on an already-bootstrapped account is a clean no-op.
#
# Public surface:
#   awsbs::ensure_kms_alias <alias>
#   awsbs::ensure_ssm_securestring <name> <description> <kms-alias>
#   awsbs::ensure_iam_role_and_profile <role> <profile> <github-key> <oauth-key> <log-group> <kms-alias>
#   awsbs::ensure_security_group <name> <description>
#   awsbs::ensure_log_group <name>
#   awsbs::ensure_agent_stuck_label <repo> <label>
#   awsbs::run_all
#
# `awsbs::run_all` reads from env:
#   RALPH_TARGET_REPO              required (owner/repo)
#   RALPH_GITHUB_TOKEN_SSM_KEY     defaults to /ralph/github-pat
#   RALPH_CLAUDE_OAUTH_SSM_KEY     defaults to /ralph/claude-oauth-credential
#   RALPH_LOG_GROUP                defaults to /ralph/main
#   AWS_REGION                     forced to eu-central-1 if unset
#
# Idempotency contract:
#   Every ensure_* function probes for the resource's current state and only
#   issues create/put calls when state is missing. On second run the only
#   AWS calls made are read-only describes/gets.
#
# Exit codes:
#   0   success
#   2   usage / missing required env var
#   non-zero   propagated from `aws` or `gh`
#
# Dependencies: aws CLI v2 (authenticated, region-aware), gh (authenticated
# for the target repo), jq.
#
# Library file. Do not set strict shell options here (would affect callers).

AWSBS_REGION="${AWSBS_REGION:-eu-central-1}"
AWSBS_KMS_ALIAS="${AWSBS_KMS_ALIAS:-alias/ralph}"
AWSBS_IAM_ROLE="${AWSBS_IAM_ROLE:-ralph-ec2-role}"
AWSBS_IAM_PROFILE="${AWSBS_IAM_PROFILE:-ralph-ec2-profile}"
AWSBS_SG_NAME="${AWSBS_SG_NAME:-ralph-sg}"
AWSBS_AGENT_STUCK_LABEL="${AWSBS_AGENT_STUCK_LABEL:-agent-stuck}"
AWSBS_AGENT_STUCK_COLOR="${AWSBS_AGENT_STUCK_COLOR:-d73a4a}"

awsbs::__err() {
    printf 'aws-bootstrap: error: %s\n' "$*" >&2
}

awsbs::__info() {
    printf 'aws-bootstrap: %s\n' "$*"
}

awsbs::__aws() {
    aws --region "$AWSBS_REGION" "$@"
}

awsbs::__account_id() {
    awsbs::__aws sts get-caller-identity --query Account --output text
}

# awsbs::ensure_kms_alias <alias>
#
# Ensures a KMS CMK exists behind the given alias. If the alias resolves,
# nothing is done. Otherwise a new symmetric encryption key is created and
# the alias is pointed at it.
awsbs::ensure_kms_alias() {
    local alias="${1:?alias required}"
    if awsbs::__aws kms describe-key --key-id "$alias" >/dev/null 2>&1; then
        awsbs::__info "kms: ${alias} already exists"
        return 0
    fi
    local key_id
    key_id=$(awsbs::__aws kms create-key \
        --description "ralph-harness CMK (used by ${alias})" \
        --key-usage ENCRYPT_DECRYPT \
        --query 'KeyMetadata.KeyId' \
        --output text) || return $?
    awsbs::__aws kms create-alias \
        --alias-name "$alias" \
        --target-key-id "$key_id" || return $?
    awsbs::__info "kms: created ${alias} -> ${key_id}"
}

# awsbs::ensure_ssm_securestring <name> <description> <kms-alias>
#
# Ensures a SecureString parameter exists at <name>. If missing, creates it
# with a placeholder value the operator is expected to overwrite (slice 4
# wires the credential-syncer for that). If present, leaves it untouched —
# we never overwrite an existing parameter.
awsbs::ensure_ssm_securestring() {
    local name="${1:?name required}"
    local description="${2:?description required}"
    local kms_alias="${3:?kms_alias required}"
    if awsbs::__aws ssm get-parameter --name "$name" --with-decryption >/dev/null 2>&1; then
        awsbs::__info "ssm: ${name} already exists"
        return 0
    fi
    awsbs::__aws ssm put-parameter \
        --name "$name" \
        --description "$description" \
        --type SecureString \
        --key-id "$kms_alias" \
        --value 'PLACEHOLDER-set-via-credential-syncer' \
        --no-overwrite >/dev/null || return $?
    awsbs::__info "ssm: created ${name}"
}

awsbs::__inline_policy_doc() {
    local account="$1" github_key="$2" oauth_key="$3" log_group="$4" kms_alias="$5"
    cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAssignedSSMParameters",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": [
        "arn:aws:ssm:${AWSBS_REGION}:${account}:parameter${github_key}",
        "arn:aws:ssm:${AWSBS_REGION}:${account}:parameter${oauth_key}"
      ]
    },
    {
      "Sid": "DecryptRalphKMS",
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {"kms:ResourceAliases": "${kms_alias}"}
      }
    },
    {
      "Sid": "PutRalphLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      "Resource": "arn:aws:logs:${AWSBS_REGION}:${account}:log-group:${log_group}:*"
    }
  ]
}
EOF
}

awsbs::__trust_policy_doc() {
    cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF
}

# awsbs::ensure_iam_role_and_profile <role> <profile> <github-key> <oauth-key> <log-group> <kms-alias>
#
# Ensures the EC2 role exists with:
#   - EC2 trust policy
#   - AmazonSSMManagedInstanceCore managed policy attached
#   - Inline policy `ralph-inline` granting SSM read on the two assigned
#     parameter keys, kms:Decrypt scoped to <kms-alias>, and PutLogEvents
#     scoped to <log-group>.
# Ensures the instance profile exists and the role is attached to it.
awsbs::ensure_iam_role_and_profile() {
    local role="${1:?role required}"
    local profile="${2:?profile required}"
    local github_key="${3:?github_key required}"
    local oauth_key="${4:?oauth_key required}"
    local log_group="${5:?log_group required}"
    local kms_alias="${6:?kms_alias required}"

    local account
    account=$(awsbs::__account_id) || return $?

    local trust_doc inline_doc
    trust_doc=$(awsbs::__trust_policy_doc)
    inline_doc=$(awsbs::__inline_policy_doc "$account" "$github_key" "$oauth_key" "$log_group" "$kms_alias")

    if awsbs::__aws iam get-role --role-name "$role" >/dev/null 2>&1; then
        awsbs::__info "iam: role ${role} already exists"
    else
        awsbs::__aws iam create-role \
            --role-name "$role" \
            --description "ralph-harness EC2 worker role" \
            --assume-role-policy-document "$trust_doc" >/dev/null || return $?
        awsbs::__info "iam: created role ${role}"
    fi

    # Attach the managed policy unconditionally — the API is idempotent: a
    # second call to attach a policy already on the role is a no-op success.
    # We probe first so the second-run reports cleanly.
    if awsbs::__aws iam list-attached-role-policies --role-name "$role" \
        --query 'AttachedPolicies[?PolicyName==`AmazonSSMManagedInstanceCore`].PolicyName' \
        --output text 2>/dev/null | grep -q AmazonSSMManagedInstanceCore; then
        awsbs::__info "iam: AmazonSSMManagedInstanceCore already attached to ${role}"
    else
        awsbs::__aws iam attach-role-policy \
            --role-name "$role" \
            --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore || return $?
        awsbs::__info "iam: attached AmazonSSMManagedInstanceCore to ${role}"
    fi

    # Inline policy: compare current document to desired. Only put if
    # different or missing.
    local existing
    existing=$(awsbs::__aws iam get-role-policy \
        --role-name "$role" \
        --policy-name ralph-inline \
        --query 'PolicyDocument' \
        --output json 2>/dev/null) || existing=""
    local desired_compact existing_compact
    desired_compact=$(printf '%s' "$inline_doc" | jq -cS .)
    if [[ -n "$existing" ]]; then
        existing_compact=$(printf '%s' "$existing" | jq -cS .)
    else
        existing_compact=""
    fi
    if [[ "$desired_compact" == "$existing_compact" ]]; then
        awsbs::__info "iam: inline policy ralph-inline already up to date on ${role}"
    else
        awsbs::__aws iam put-role-policy \
            --role-name "$role" \
            --policy-name ralph-inline \
            --policy-document "$inline_doc" || return $?
        awsbs::__info "iam: wrote inline policy ralph-inline on ${role}"
    fi

    if awsbs::__aws iam get-instance-profile --instance-profile-name "$profile" >/dev/null 2>&1; then
        awsbs::__info "iam: instance profile ${profile} already exists"
    else
        awsbs::__aws iam create-instance-profile \
            --instance-profile-name "$profile" >/dev/null || return $?
        awsbs::__info "iam: created instance profile ${profile}"
    fi

    if awsbs::__aws iam get-instance-profile \
        --instance-profile-name "$profile" \
        --query 'InstanceProfile.Roles[?RoleName==`'"$role"'`].RoleName' \
        --output text 2>/dev/null | grep -q "$role"; then
        awsbs::__info "iam: role ${role} already attached to profile ${profile}"
    else
        awsbs::__aws iam add-role-to-instance-profile \
            --instance-profile-name "$profile" \
            --role-name "$role" || return $?
        awsbs::__info "iam: attached role ${role} to profile ${profile}"
    fi
}

# awsbs::ensure_security_group <name> <description>
#
# Ensures a security group named <name> exists in the region's default VPC.
# Newly-created groups inherit the default "no inbound rules, all outbound
# allowed" posture, which is what the harness wants — so no rule edits are
# made beyond creation.
awsbs::ensure_security_group() {
    local name="${1:?name required}"
    local description="${2:?description required}"

    local vpc_id
    vpc_id=$(awsbs::__aws ec2 describe-vpcs \
        --filters Name=is-default,Values=true \
        --query 'Vpcs[0].VpcId' \
        --output text) || return $?
    if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
        awsbs::__err "no default VPC in region ${AWSBS_REGION}; refusing to create security group"
        return 1
    fi

    local existing
    existing=$(awsbs::__aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${name}" "Name=vpc-id,Values=${vpc_id}" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null) || existing=""
    if [[ -n "$existing" && "$existing" != "None" ]]; then
        awsbs::__info "ec2: security group ${name} already exists (${existing})"
        return 0
    fi

    local sg_id
    sg_id=$(awsbs::__aws ec2 create-security-group \
        --group-name "$name" \
        --description "$description" \
        --vpc-id "$vpc_id" \
        --query 'GroupId' \
        --output text) || return $?
    awsbs::__info "ec2: created security group ${name} (${sg_id})"
}

# awsbs::ensure_log_group <name>
awsbs::ensure_log_group() {
    local name="${1:?name required}"
    local existing
    existing=$(awsbs::__aws logs describe-log-groups \
        --log-group-name-prefix "$name" \
        --query "logGroups[?logGroupName=='${name}'].logGroupName" \
        --output text 2>/dev/null) || existing=""
    if [[ -n "$existing" && "$existing" != "None" ]]; then
        awsbs::__info "logs: log group ${name} already exists"
        return 0
    fi
    awsbs::__aws logs create-log-group --log-group-name "$name" || return $?
    awsbs::__info "logs: created log group ${name}"
}

# awsbs::ensure_agent_stuck_label <repo> <label>
#
# Ensures the target repo has a label named <label> (red). Uses `gh label`.
awsbs::ensure_agent_stuck_label() {
    local repo="${1:?repo required}"
    local label="${2:?label required}"
    if gh label list --repo "$repo" --json name --jq '.[].name' 2>/dev/null \
        | grep -Fxq "$label"; then
        awsbs::__info "github: label ${label} already exists on ${repo}"
        return 0
    fi
    gh label create "$label" \
        --repo "$repo" \
        --color "$AWSBS_AGENT_STUCK_COLOR" \
        --description "Set by ralph-harness when an iteration escapes via the stuck-budget path." \
        >/dev/null || return $?
    awsbs::__info "github: created label ${label} on ${repo}"
}

# awsbs::run_all
#
# Reads required config from env and ensures every resource. Idempotent.
awsbs::run_all() {
    local repo="${RALPH_TARGET_REPO:-}"
    if [[ -z "$repo" ]]; then
        awsbs::__err "RALPH_TARGET_REPO is required (e.g. owner/repo)"
        return 2
    fi
    local github_key="${RALPH_GITHUB_TOKEN_SSM_KEY:-/ralph/github-pat}"
    local oauth_key="${RALPH_CLAUDE_OAUTH_SSM_KEY:-/ralph/claude-oauth-credential}"
    local log_group="${RALPH_LOG_GROUP:-/ralph/main}"

    awsbs::__info "region=${AWSBS_REGION} target=${repo}"
    awsbs::__info "github_key=${github_key} oauth_key=${oauth_key} log_group=${log_group}"

    awsbs::ensure_kms_alias "$AWSBS_KMS_ALIAS" || return $?
    awsbs::ensure_ssm_securestring "$github_key" \
        "ralph-harness GitHub PAT (SecureString placeholder)" "$AWSBS_KMS_ALIAS" || return $?
    awsbs::ensure_ssm_securestring "$oauth_key" \
        "ralph-harness Claude OAuth credential (SecureString placeholder)" "$AWSBS_KMS_ALIAS" || return $?
    awsbs::ensure_log_group "$log_group" || return $?
    awsbs::ensure_iam_role_and_profile \
        "$AWSBS_IAM_ROLE" "$AWSBS_IAM_PROFILE" \
        "$github_key" "$oauth_key" "$log_group" "$AWSBS_KMS_ALIAS" || return $?
    awsbs::ensure_security_group "$AWSBS_SG_NAME" \
        "ralph-harness EC2 worker (no inbound, all outbound)" || return $?
    awsbs::ensure_agent_stuck_label "$repo" "$AWSBS_AGENT_STUCK_LABEL" || return $?
}
