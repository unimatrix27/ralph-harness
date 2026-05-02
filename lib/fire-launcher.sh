# shellcheck shell=bash
#
# fire-launcher.sh — fires one throwaway EC2 instance per iteration and
# enforces the wall-clock backstop from the laptop side. Slice 5 ships a
# hello-world cloud-init payload (no orchestrator yet) — just enough to
# prove launch + tagging + IAM + instance-initiated-shutdown + log
# streaming + the 75-min ceiling all work end-to-end.
#
# Public surface:
#   fire::run
#
# Reads from env (with overridable defaults):
#   RALPH_AWS_REGION         eu-central-1
#   RALPH_LOG_GROUP          /ralph/main
#   RALPH_INSTANCE_TYPE      t3a.large
#   RALPH_ROOT_VOLUME_GB     30
#   RALPH_SG_NAME            ralph-sg                    (created by aws-bootstrap)
#   RALPH_IAM_PROFILE        ralph-ec2-profile           (created by aws-bootstrap)
#   RALPH_AMI_SSM_PARAM      /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
#   RALPH_MAX_LIFETIME_MIN   75
#   RALPH_POLL_INTERVAL_SEC  20
#   FIRE_USER_DATA_FILE      override path to cloud-init payload
#                            (default: <this-dir>/cloud-init/hello.sh)
#
# Exit codes:
#   0   instance terminated cleanly within the ceiling
#   2   missing AWS-side resource (e.g. security group not bootstrapped)
#   3   wall-clock ceiling breached; force terminate-instances was issued
#   non-zero   propagated from `aws`
#
# Cleanup contract (defense in depth):
#   - cloud-init runs `shutdown -h now` via a bash EXIT trap
#   - the instance is launched with --instance-initiated-shutdown-behavior=terminate
#   - this launcher polls describe-instances and force-terminates on ceiling
#
# Networking / posture:
#   - default VPC, default-AZ public subnet, auto-assigned public IP
#   - security group has no inbound rules; SSM Session Manager is the only
#     debug entry point
#   - no SSH keys ever
#
# Dependencies: aws CLI v2 (authenticated, region-aware), jq.
#
# Library file. Do not set strict shell options here (would affect callers).

FIRE_REGION="${RALPH_AWS_REGION:-eu-central-1}"
FIRE_LOG_GROUP="${RALPH_LOG_GROUP:-/ralph/main}"
FIRE_INSTANCE_TYPE="${RALPH_INSTANCE_TYPE:-t3a.large}"
FIRE_ROOT_VOLUME_GB="${RALPH_ROOT_VOLUME_GB:-30}"
FIRE_SG_NAME="${RALPH_SG_NAME:-ralph-sg}"
FIRE_IAM_PROFILE="${RALPH_IAM_PROFILE:-ralph-ec2-profile}"
FIRE_AMI_SSM_PARAM="${RALPH_AMI_SSM_PARAM:-/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}"
FIRE_MAX_LIFETIME_MIN="${RALPH_MAX_LIFETIME_MIN:-75}"
FIRE_POLL_INTERVAL_SEC="${RALPH_POLL_INTERVAL_SEC:-20}"

fire::__err()  { printf 'fire-launcher: error: %s\n' "$*" >&2; }
fire::__info() { printf 'fire-launcher: %s\n' "$*"; }

fire::__aws() { aws --region "$FIRE_REGION" "$@"; }

fire::__resolve_default_vpc() {
    local vpc_id
    vpc_id=$(fire::__aws ec2 describe-vpcs \
        --filters Name=is-default,Values=true \
        --query 'Vpcs[0].VpcId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
        fire::__err "no default VPC in region ${FIRE_REGION}"
        return 2
    fi
    printf '%s' "$vpc_id"
}

fire::__resolve_public_subnet() {
    local vpc_id="${1:?vpc_id required}"
    local subnet_id
    subnet_id=$(fire::__aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=default-for-az,Values=true" \
        --query 'Subnets[0].SubnetId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$subnet_id" || "$subnet_id" == "None" ]]; then
        fire::__err "no default subnet in vpc ${vpc_id}"
        return 2
    fi
    printf '%s' "$subnet_id"
}

fire::__resolve_security_group() {
    local vpc_id="${1:?vpc_id required}"
    local name="${2:?name required}"
    local sg_id
    sg_id=$(fire::__aws ec2 describe-security-groups \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=group-name,Values=${name}" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
        fire::__err "security group ${name} not found in vpc ${vpc_id}; run bin/bootstrap-aws.sh first"
        return 2
    fi
    printf '%s' "$sg_id"
}

fire::__resolve_image_id() {
    local image_id
    image_id=$(fire::__aws ssm get-parameter \
        --name "$FIRE_AMI_SSM_PARAM" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null) || return $?
    if [[ -z "$image_id" || "$image_id" == "None" ]]; then
        fire::__err "could not resolve AL2023 image id from ${FIRE_AMI_SSM_PARAM}"
        return 2
    fi
    printf '%s' "$image_id"
}

fire::__user_data_file() {
    if [[ -n "${FIRE_USER_DATA_FILE:-}" ]]; then
        printf '%s' "$FIRE_USER_DATA_FILE"
        return 0
    fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s' "${here}/cloud-init/hello.sh"
}

# fire::__render_user_data <log-group>
#
# Emits a complete cloud-init script: a single shebang, a small env shim
# exporting the runtime values the payload reads, then the hello payload
# (with its own leading shebang stripped).
fire::__render_user_data() {
    local log_group="${1:?log_group required}"
    local file
    file=$(fire::__user_data_file)
    if [[ ! -f "$file" ]]; then
        fire::__err "user-data file not found: ${file}"
        return 2
    fi
    {
        printf '#!/bin/bash\n'
        printf 'export LOG_GROUP_NAME=%q\n' "$log_group"
        sed '1{/^#!/d;}' "$file"
    }
}

fire::__tag_spec() {
    local max="${1:?max required}"
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat <<JSON
[
  {"ResourceType":"instance","Tags":[
    {"Key":"Project","Value":"ralph"},
    {"Key":"Name","Value":"ralph-harness"},
    {"Key":"LaunchedAt","Value":"${ts}"},
    {"Key":"MaxLifetimeMin","Value":"${max}"}
  ]},
  {"ResourceType":"volume","Tags":[
    {"Key":"Project","Value":"ralph"},
    {"Key":"LaunchedAt","Value":"${ts}"},
    {"Key":"MaxLifetimeMin","Value":"${max}"}
  ]}
]
JSON
}

fire::__block_device_mapping() {
    local gb="${1:?gb required}"
    cat <<JSON
[{
  "DeviceName":"/dev/xvda",
  "Ebs":{"VolumeSize":${gb},"VolumeType":"gp3","DeleteOnTermination":true}
}]
JSON
}

fire::__run_instance() {
    local image_id="${1:?image_id required}"
    local subnet_id="${2:?subnet_id required}"
    local sg_id="${3:?sg_id required}"
    local user_data_file="${4:?user_data_file required}"
    local tag_file="${5:?tag_file required}"
    local bdm_file="${6:?bdm_file required}"

    fire::__aws ec2 run-instances \
        --image-id "$image_id" \
        --instance-type "$FIRE_INSTANCE_TYPE" \
        --subnet-id "$subnet_id" \
        --security-group-ids "$sg_id" \
        --associate-public-ip-address \
        --iam-instance-profile "Name=${FIRE_IAM_PROFILE}" \
        --instance-initiated-shutdown-behavior terminate \
        --user-data "file://${user_data_file}" \
        --block-device-mappings "file://${bdm_file}" \
        --tag-specifications "file://${tag_file}" \
        --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2" \
        --query 'Instances[0].InstanceId' \
        --output text
}

# fire::__wait_for_terminated <instance-id>
#
# Polls describe-instances until State.Name == terminated. On wall-clock
# ceiling breach issues a force terminate-instances and returns 3.
fire::__wait_for_terminated() {
    local instance_id="${1:?instance_id required}"
    local deadline
    deadline=$(( $(date +%s) + FIRE_MAX_LIFETIME_MIN * 60 ))
    while :; do
        local state
        state=$(fire::__aws ec2 describe-instances \
            --instance-ids "$instance_id" \
            --query 'Reservations[0].Instances[0].State.Name' \
            --output text 2>/dev/null) || state=""
        case "$state" in
            terminated)
                fire::__info "instance ${instance_id} terminated"
                return 0
                ;;
            "")
                fire::__info "could not read state for ${instance_id}; retrying"
                ;;
            *)
                fire::__info "instance ${instance_id} state=${state}"
                ;;
        esac
        if (( $(date +%s) >= deadline )); then
            fire::__err "wall-clock ceiling (${FIRE_MAX_LIFETIME_MIN}m) breached; forcing terminate"
            fire::__aws ec2 terminate-instances --instance-ids "$instance_id" >/dev/null 2>&1 || true
            return 3
        fi
        sleep "$FIRE_POLL_INTERVAL_SEC"
    done
}

fire::run() {
    local vpc_id subnet_id sg_id image_id
    vpc_id=$(fire::__resolve_default_vpc) || return $?
    subnet_id=$(fire::__resolve_public_subnet "$vpc_id") || return $?
    sg_id=$(fire::__resolve_security_group "$vpc_id" "$FIRE_SG_NAME") || return $?
    image_id=$(fire::__resolve_image_id) || return $?

    fire::__info "region=${FIRE_REGION} vpc=${vpc_id} subnet=${subnet_id} sg=${sg_id} ami=${image_id}"
    fire::__info "instance_type=${FIRE_INSTANCE_TYPE} root_gb=${FIRE_ROOT_VOLUME_GB} max_lifetime_min=${FIRE_MAX_LIFETIME_MIN}"

    local tmp
    tmp=$(mktemp -d -t ralph-fire) || return $?
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT INT TERM

    local user_data_file="${tmp}/user-data.sh"
    local tag_file="${tmp}/tags.json"
    local bdm_file="${tmp}/bdm.json"
    fire::__render_user_data "$FIRE_LOG_GROUP" > "$user_data_file" || return $?
    fire::__tag_spec "$FIRE_MAX_LIFETIME_MIN" > "$tag_file"
    fire::__block_device_mapping "$FIRE_ROOT_VOLUME_GB" > "$bdm_file"

    local instance_id
    instance_id=$(fire::__run_instance \
        "$image_id" "$subnet_id" "$sg_id" \
        "$user_data_file" "$tag_file" "$bdm_file") || return $?
    if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
        fire::__err "run-instances did not return an instance id"
        return 1
    fi
    fire::__info "launched ${instance_id}"
    fire::__info "log_group=${FIRE_LOG_GROUP} log_stream=${instance_id}"
    fire::__info "tail with: aws --region ${FIRE_REGION} logs tail ${FIRE_LOG_GROUP} --log-stream-names ${instance_id} --follow"

    fire::__wait_for_terminated "$instance_id"
}
