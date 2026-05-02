#!/bin/bash
#
# Cloud-init hello payload (slice 5). No claude calls, no orchestrator —
# just enough to prove the launcher path works end-to-end:
#
#   - resolve instance metadata via IMDSv2
#   - emit PHASE_START / PHASE_END / OUTCOME=hello on stdout
#   - tee stdout to /var/log/ralph.log
#   - ship that log to CloudWatch (group=$LOG_GROUP_NAME, stream=$INSTANCE_ID)
#   - shutdown -h now via bash EXIT trap, on success or failure
#
# Inputs (env, set by fire-launcher's user-data shim):
#   LOG_GROUP_NAME      CloudWatch log group (default /ralph/main)
#
# AL2023 ships aws CLI v2 and python3 in the base image, so this script has
# no extra package install step.

set -uo pipefail

: "${LOG_GROUP_NAME:=/ralph/main}"
LOG_FILE="/var/log/ralph.log"
: > "$LOG_FILE"

ralph__md_token=$(curl -fsS -m 5 -X PUT \
    "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)

ralph__md() {
    curl -fsS -m 5 \
        -H "X-aws-ec2-metadata-token: ${ralph__md_token}" \
        "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
}

INSTANCE_ID=$(ralph__md instance-id)
REGION=$(ralph__md placement/region)
LOG_STREAM="${INSTANCE_ID:-unknown-instance}"

ralph__flush_logs() {
    [[ -z "$REGION" ]] && return 0
    aws --region "$REGION" logs create-log-stream \
        --log-group-name "$LOG_GROUP_NAME" \
        --log-stream-name "$LOG_STREAM" >/dev/null 2>&1 || true
    [[ -s "$LOG_FILE" ]] || return 0
    local req
    req=$(LOG_FILE="$LOG_FILE" \
          LOG_GROUP_NAME="$LOG_GROUP_NAME" \
          LOG_STREAM="$LOG_STREAM" \
          python3 - <<'PY' 2>/dev/null
import json, os, time
ts = int(time.time() * 1000)
events = []
with open(os.environ["LOG_FILE"]) as f:
    for i, line in enumerate(f.read().splitlines()):
        if line:
            events.append({"timestamp": ts + i, "message": line})
if events:
    print(json.dumps({
        "logGroupName": os.environ["LOG_GROUP_NAME"],
        "logStreamName": os.environ["LOG_STREAM"],
        "logEvents": events,
    }))
PY
    )
    [[ -z "$req" ]] && return 0
    local tmp
    tmp=$(mktemp -t ralph-logs) || return 0
    chmod 600 "$tmp"
    printf '%s' "$req" > "$tmp"
    aws --region "$REGION" logs put-log-events \
        --cli-input-json "file://${tmp}" >/dev/null 2>&1 || true
    rm -f "$tmp"
}

ralph__shutdown_now() {
    ralph__flush_logs
    /sbin/shutdown -h now 2>/dev/null \
        || /usr/sbin/shutdown -h now 2>/dev/null \
        || shutdown -h now 2>/dev/null \
        || halt -p 2>/dev/null \
        || poweroff
}

# AC8: bash EXIT trap shuts the box down on any exit (success or failure).
# Instance was launched with --instance-initiated-shutdown-behavior=terminate,
# so OS shutdown == EC2 termination.
trap ralph__shutdown_now EXIT

ralph__main() {
    local now
    now=$(date -u +%FT%TZ)
    echo "PHASE_START phase=hello instance=${INSTANCE_ID} region=${REGION} ts=${now}"
    echo "ralph-harness slice 5 hello payload"
    echo "log_group=${LOG_GROUP_NAME} log_stream=${LOG_STREAM}"
    echo "PHASE_END phase=hello ts=$(date -u +%FT%TZ)"
    echo "OUTCOME=hello"
}

ralph__main 2>&1 | tee -a "$LOG_FILE"
