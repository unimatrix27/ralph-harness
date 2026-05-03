# End-to-end smoke test (HITL)

Iteration-1 closeout runbook. Executes the full chain on a **fresh AWS account**
against a **no-op test issue** in a sandbox target repo, top to bottom:
`bootstrap-aws` → `sync-credential` → seed GitHub PAT → `fire` → observe phase
markers → verify PR shape → verify cleanup.

This is **human-in-the-loop**: the operator runs each step, eyeballs output,
and signs off in the closeout issue. The harness itself does not self-verify
the smoke test.

## Acceptance signal

> Every phase reached `PHASE_END` on the per-instance CloudWatch stream and the
> instance is in state `terminated` (no leaked EC2, no leaked volume).

If discovery picks the no-op test issue, an additional signal is:

> A PR exists on the target repo whose body carries the launch-tag HTML
> comment, and either `OUTCOME=pr_opened … review=none` or
> `OUTCOME=pr_opened … review=revised` was emitted.

## Prerequisites

On the operator's laptop:

- `aws` CLI v2 authenticated against the **fresh test account**, region
  `eu-central-1`. Verify with `aws sts get-caller-identity`.
- `gh` authenticated against an account that has push + label-write on the
  sandbox target repo. Verify with `gh auth status`.
- `jq`, `yq` (mikefarah v4), `bats-core` installed (smoke test does not run
  bats but the harness assumes the same toolchain).
- macOS Keychain holds a valid `Claude Code-credentials` entry (run
  `claude /login` in the desktop app first).
- A **GitHub Personal Access Token** for the harness's worker, scoped to
  `repo` on the sandbox target repo. Generate once; you will paste it into
  SSM in step 3.

In the sandbox target repo (must be a real GitHub repo you control, distinct
from this harness repo):

- Committed `.ralph/config.yaml` matching `docs/config-schema.md`. Minimal:
  ```yaml
  build_cmd: "true"
  test_cmd: "true"
  branch_prefix: "ralph"
  review_bot:
    username: "claude"
    source: "comment"
  ```
  Using `true` for build/test makes any change pass without target-specific
  toolchain. Override with the real commands once the smoke test is green.
- A `ready-for-agent` label exists.
- One **no-op test issue** open and labelled `ready-for-agent`. Suggested
  body: a single self-contained ask the impl call can land in one tiny edit,
  e.g. *"Add a one-line `## Smoke test marker` heading to the bottom of
  README.md."* — small enough that build/test = `true` is honest and the PR
  diff is one line.

Set the operator-side environment for every step in this runbook:

```sh
export RALPH_TARGET_REPO=<owner>/<sandbox-repo>     # the sandbox, not this harness
# Optional overrides — leave unset to use defaults:
# export RALPH_AWS_REGION=eu-central-1
# export RALPH_LOG_GROUP=/ralph/main
# export RALPH_GITHUB_TOKEN_SSM_KEY=/ralph/github-pat
# export RALPH_CLAUDE_OAUTH_SSM_KEY=/ralph/claude-oauth-credential
```

## Step 1 — bootstrap AWS

```sh
./bin/bootstrap-aws.sh
```

Expected: each `awsbs:` info line ends with `created …` on the first run, or
`already exists` on a re-run. The script is idempotent — re-run if you are
unsure of state.

What was created (verify with the AWS console or CLI if you want belt-and-
braces):

- KMS alias `alias/ralph` (CMK)
- SSM SecureString placeholders `/ralph/github-pat` and
  `/ralph/claude-oauth-credential` (value is `PLACEHOLDER-set-via-credential-syncer`
  until the next two steps overwrite them)
- CloudWatch log group `/ralph/main`
- IAM role `ralph-ec2-role` + instance profile `ralph-ec2-profile` with
  scoped inline policy
- Security group `ralph-sg` in the default VPC (no inbound)
- Label `agent-stuck` on the target repo (or `agent_stuck_label` from
  `.ralph/config.yaml` if overridden)

Re-run the same command. Every line should now read `already exists`.

## Step 2 — sync the Claude OAuth credential

```sh
./bin/sync-credential.sh
```

Expected: a single `credential-syncer: uploaded …` info line and exit 0. The
credential never appears in stdout, stderr, or argv — confirm by visual
inspection of the output.

## Step 3 — seed the GitHub PAT into SSM

The credential syncer covers the Claude OAuth credential only. The GitHub PAT
must be uploaded by hand once per fresh account (and re-uploaded only when the
PAT is rotated):

```sh
read -rs RALPH_PAT && export RALPH_PAT
aws --region eu-central-1 ssm put-parameter \
  --name /ralph/github-pat \
  --type SecureString --key-id alias/ralph \
  --value "$RALPH_PAT" --overwrite >/dev/null
unset RALPH_PAT
```

`read -rs` keeps the PAT off the shell history and out of the visible buffer.
Verify the parameter was overwritten:

```sh
aws --region eu-central-1 ssm get-parameter \
  --name /ralph/github-pat --with-decryption \
  --query 'Parameter.{LastModifiedDate:LastModifiedDate,Version:Version}'
```

Expect `Version` ≥ 2 (initial placeholder was Version 1).

## Step 4 — fire one EC2

```sh
./bin/fire.sh
```

Expected stdout from the launcher:

```
fire-launcher: region=eu-central-1 vpc=vpc-… subnet=subnet-… sg=sg-… ami=ami-…
fire-launcher: instance_type=t3a.large root_gb=30 max_lifetime_min=75
fire-launcher: target=<owner>/<sandbox-repo> log_group=/ralph/main
fire-launcher: github_key=/ralph/github-pat oauth_key=/ralph/claude-oauth-credential
fire-launcher: launched i-…
fire-launcher: log_group=/ralph/main log_stream=i-…
fire-launcher: tail with: aws --region eu-central-1 logs tail /ralph/main --log-stream-names i-… --follow
```

Note the instance id (`i-…`) — every later step uses it. The launcher then
blocks polling `describe-instances` until the box is `terminated`, with a
75-minute ceiling.

## Step 5 — tail the per-instance CloudWatch stream

Open a second terminal (`./bin/fire.sh` is still blocking in the first one):

```sh
INSTANCE_ID=i-…    # from step 4
aws --region eu-central-1 logs tail /ralph/main \
    --log-stream-names "$INSTANCE_ID" --follow
```

Expected phase sequence (each line emits `PHASE_START …` then `PHASE_END …`):

| Phase                 | Source                  |
| --------------------- | ----------------------- |
| `install-deps`        | cloud-init bootstrap    |
| `fetch-secrets`       | cloud-init bootstrap    |
| `clone-target`        | cloud-init bootstrap    |
| `safety-guards`       | cloud-init bootstrap    |
| `configure-mcps`      | cloud-init bootstrap    |
| `load-config`         | cloud-init bootstrap    |
| `discovery`           | orchestrator            |
| `implementation`      | orchestrator (only on `PICKED`) |
| `review`              | orchestrator (only on `PR_OPENED`) |

After discovery picks an issue you should see a stable `PICKED_ISSUE=<n>`
marker, and at the end one `OUTCOME=…` line:

| Discovery / impl outcome     | Final marker                                              |
| ---------------------------- | --------------------------------------------------------- |
| no `ready-for-agent` issues  | `OUTCOME=no_work`                                         |
| all candidates are blocked   | `OUTCOME=all_blocked`                                     |
| impl succeeded, no review    | `OUTCOME=pr_opened issue=<n> pr=<m> review=none`          |
| impl succeeded, review applied | `OUTCOME=pr_opened issue=<n> pr=<m> review=revised`     |
| impl self-stopped            | `OUTCOME=agent_stuck issue=<n>`                           |

For the no-op test issue you should see `OUTCOME=pr_opened … review=none`
(default — no real review bot will respond on a sandbox repo within the
10-minute window). The CloudWatch stream stops when the instance terminates.

## Step 6 — verify the PR shape

Expected exactly one new PR on the sandbox target repo, opened by the worker:

```sh
gh pr list --repo "$RALPH_TARGET_REPO" --state open \
    --search "ralph-launch in:body" --limit 5
```

Open the PR in the browser and confirm:

- Branch name starts with `ralph/<issue-number>-…`.
- Body contains the launch-tag marker:
  `<!-- ralph-launch: i-… -->` (`i-…` matches the instance id from step 4).
- The diff is the expected one-liner against the no-op issue.
- The source issue (`#<n>`) had its `ready-for-agent` label swapped for
  `ready-for-human` (visible in the issue's timeline).

## Step 7 — wait for the launcher to return

Switch back to the first terminal. The launcher should exit `0` once
`describe-instances` reports `terminated`. The post-hoc agent-stuck check
runs unconditionally just before exit; for a clean run it logs that the
launch-tag PR was found and applies no label.

If the launcher exits `3` instead, the wall-clock ceiling was breached and
`terminate-instances` was issued by the launcher itself. The post-hoc check
will then look for a `PICKED_ISSUE=<n>` marker on the CloudWatch stream and
apply `agent-stuck` to the source issue if one is recoverable.

## Step 8 — verify cleanup

```sh
aws --region eu-central-1 ec2 describe-instances \
    --filters "Name=tag:Project,Values=ralph" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text
```

Expect empty output. Anything non-empty is a leak — investigate before
declaring success.

```sh
aws --region eu-central-1 ec2 describe-volumes \
    --filters "Name=tag:Project,Values=ralph" \
              "Name=status,Values=available" \
    --query 'Volumes[].VolumeId' --output text
```

Expect empty output. Root volumes attached to a `--instance-initiated-shutdown-behavior=terminate`
instance are deleted on termination; an `available` (= detached) volume tagged
`Project=ralph` indicates an EC2 launch that did not terminate cleanly.

## Step 9 — sign off

Post a comment on the iteration-1 closeout issue (#11) recording:

- Instance id from step 4
- Final `OUTCOME=…` line from step 5
- PR number from step 6
- Confirmation of empty output from both step-8 commands

Suggested template:

```
Smoke test passed.

- Instance: i-…
- OUTCOME: pr_opened issue=<n> pr=<m> review=none
- PR: <url>
- Cleanup: 0 leaked instances, 0 leaked volumes
```

Sign-off comment closes the HITL loop.

## When something goes wrong

- **`fire-launcher: error: …` before any phase marker on CloudWatch.**
  AWS-side resource missing or not reachable. Re-run step 1; the bootstrap
  is idempotent and will report what it created vs. what was already there.
- **`PHASE_START phase=fetch-secrets` followed by an error.** The SSM
  parameter is still the placeholder. Re-run step 2 (Claude OAuth) and
  step 3 (GitHub PAT).
- **No phase markers at all on CloudWatch but instance reaches
  `terminated`.** Cloud-init failed before the log streamer attached. SSM
  Session Manager into a held-open instance is not possible (the box
  shutdown-on-EXIT). Re-fire and watch the CloudWatch stream from the
  moment the launcher prints the instance id.
- **Wall-clock ceiling (`fire-launcher` exits 3).** The orchestrator did
  not finish within `RALPH_MAX_LIFETIME_MIN` (default 75). The post-hoc
  check labels the source issue `agent-stuck`. Inspect the CloudWatch
  stream for the last `PHASE_START` to identify which call hung.
