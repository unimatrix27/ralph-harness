# ralph-harness

Throwaway-EC2 loop that picks one `ready-for-agent` GitHub issue, implements it
on a fresh branch, opens a PR, and incorporates one auto-review pass — then
terminates.

Generic. Target repo + target-specific config supplied at runtime.

Status: iteration 1, in progress (single-fire from laptop). See issue #1 for
the PRD and the open issues for the slice plan.

## Public-safe

This repository contains zero target-specific identifiers. Every target knob is
supplied at runtime via the target repo's `.ralph/config.yaml` and via
environment variables / SSM. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
contract.

## What's here today

Slice 1 — target-config-schema:

- [`docs/config-schema.md`](docs/config-schema.md) — full schema for the
  `.ralph/config.yaml` file every target repo must commit.
- [`lib/target-config-schema.sh`](lib/target-config-schema.sh) — sourceable
  bash module that loads and validates a target repo's `.ralph/config.yaml`.
  Fails loud with a useful message on any error.
- [`bin/load-config`](bin/load-config) — thin CLI over the validator. Exits 0
  on valid input, non-zero on bad input.

Slice 2 — github-state-mutator:

- [`lib/github-state-mutator.sh`](lib/github-state-mutator.sh) — idempotent
  shell wrappers around `gh` for the four state mutations the orchestrator
  needs: `swap_label`, `comment_issue`,
  `find_or_create_milestone_log_issue`, `append_caveman_log`.
- [`bin/gsm`](bin/gsm) — CLI for manual verification against a sandbox repo.

Slice 3 — aws-bootstrap:

- [`lib/aws-bootstrap.sh`](lib/aws-bootstrap.sh) — idempotent `awsbs::ensure_*`
  functions for every AWS-side resource the harness needs (KMS alias `alias/ralph`,
  SSM SecureString placeholders, EC2 IAM role + instance profile with
  minimum-scope inline policy, security group in the default VPC, CloudWatch
  log group) plus the target-side `agent-stuck` label.
- [`bin/bootstrap-aws.sh`](bin/bootstrap-aws.sh) — single-shot CLI: reads
  config from env, ensures every resource, second run is a clean no-op.
  Region is forced to `eu-central-1`.

Slice 5 — fire-launcher (single-fire EC2 + CloudWatch streaming):

- [`lib/fire-launcher.sh`](lib/fire-launcher.sh) — fires one throwaway EC2
  in `eu-central-1` (`t3a.large`, 30 GB gp3, AL2023 from public SSM AMI
  parameter, default-VPC public subnet, auto-assigned public IP, IMDSv2
  required) using the bootstrapped IAM instance profile and security group.
  Tags every instance + volume `Project=ralph` plus a UTC `LaunchedAt`
  timestamp and `MaxLifetimeMin`. Launches with
  `--instance-initiated-shutdown-behavior terminate`, then polls
  `describe-instances` until `terminated`. On the 75-minute ceiling the
  launcher force-`terminate-instances` and exits non-zero.
- [`lib/cloud-init/hello.sh`](lib/cloud-init/hello.sh) — slice 5's
  hello-world cloud-init payload. Emits `PHASE_START` / `PHASE_END` /
  `OUTCOME=hello`, ships the run's stdout to CloudWatch
  (`/ralph/main`, stream-per-instance), and runs `shutdown -h now` via a
  bash `trap EXIT` so the box terminates on any exit (success or failure).
  No SSH; SSM Session Manager is the only debug entry point.
- [`bin/fire.sh`](bin/fire.sh) — single-shot launcher CLI.

```sh
# Fire one EC2 (slice 5 hello payload):
RALPH_TARGET_REPO=owner/target ./bin/fire.sh

# Tail the per-instance CloudWatch stream:
aws --region eu-central-1 logs tail /ralph/main \
    --log-stream-names <i-...> --follow
```

Slice 4 — credential-syncer (macOS only):

- [`lib/credential-syncer.sh`](lib/credential-syncer.sh) — reads the
  `Claude Code-credentials` entry from the macOS Keychain and uploads it to
  the SSM SecureString at `/ralph/claude-oauth-credential` (overridable via
  `RALPH_CLAUDE_OAUTH_SSM_KEY`), encrypted under `alias/ralph`.
- [`bin/sync-credential.sh`](bin/sync-credential.sh) — thin CLI wrapper.
  Region is forced to `eu-central-1`. The credential is passed to `aws` via
  `--cli-input-json file://...` (mode 0600, removed on exit) so it is never
  visible on any process's argv, and is never echoed in info or error output.

Run after every desktop `claude /login`:

```sh
./bin/sync-credential.sh
# or with a custom key:
RALPH_CLAUDE_OAUTH_SSM_KEY=/ralph/claude-oauth-credential ./bin/sync-credential.sh
```

Caveats:

- **Rotation:** every desktop `claude /login` may invalidate the prior
  refresh token. Re-run `bin/sync-credential.sh` immediately after each
  login so the EC2 worker picks up the fresh credential.
- **Concurrent use unverified:** simultaneous use of the same credential by
  the desktop app and an EC2 worker has not been validated; assume one
  active consumer at a time.
- **Plan limits:** the EC2 worker burns the engineer's Claude plan limits
  while running.
- **OAuth-vs-API-key:** iteration 1 ships OAuth-via-Keychain. Switching to a
  long-lived API key is a one-file change in the future `ec2-bootstrap`
  module (see issue #7).

[`tests/`](tests/) holds bats-core tests with yaml fixtures and stubbed
`gh` and `aws` binaries on `PATH`.

```sh
# Validate a config file by hand:
./bin/load-config path/to/.ralph/config.yaml

# Manually swap a label on a sandbox repo:
./bin/gsm swap-label owner/sandbox 1 ready-for-agent ready-for-human

# Bootstrap AWS resources for a target repo (idempotent):
RALPH_TARGET_REPO=owner/target ./bin/bootstrap-aws.sh

# Sync the macOS Keychain credential into SSM (re-run after every claude /login):
./bin/sync-credential.sh

# Fire one throwaway EC2 instance (slice 5 hello payload):
./bin/fire.sh

# Run the test suite:
bats tests/
```

Dependencies: `yq` (mikefarah/yq v4), `jq`, `gh`, `aws` (CLI v2), and
`bats-core`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for install hints.

## Schema at a glance

A target repo's `.ralph/config.yaml` looks like:

```yaml
build_cmd: "make build"
test_cmd: "make test"
branch_prefix: "ralph"
review_bot:
  username: "claude"
  source: "comment"
# optional:
agent_stuck_label: "agent-stuck"
prompt_extensions:
  discovery: |
    ...extra discovery-prompt instructions...
  implementation: |
    ...extra impl-prompt instructions...
  review: |
    ...extra review-prompt instructions...
```

See [`docs/config-schema.md`](docs/config-schema.md) for the full spec, types,
and validation rules.
