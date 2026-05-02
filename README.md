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
- [`bin/fire.sh`](bin/fire.sh) — single-shot launcher CLI.

Slice 8 — implementation call:

- [`prompts/implementation.md`](prompts/implementation.md) — generic
  implementation prompt template. Target context (repo, default branch,
  work dir, build/test commands, branch prefix, agent-stuck label,
  per-launch tag, optional `prompt_extensions.implementation`) is
  injected via `{{...}}` placeholders at render time; the template
  itself contains zero target-specific identifiers.
- `lib/ec2-orchestrator.sh` — `orch::run` now chains the implementation
  call onto the `PICKED` branch from discovery: renders
  `prompts/implementation.md`, appends the crafted context discovery
  wrote to `/tmp/ralph/crafted-prompt.md`, invokes `claude --print`,
  wraps the call in `PHASE_START phase=implementation` /
  `PHASE_END phase=implementation duration_s=... issue=<n> status=...`
  markers (status comes from the result file so a CloudWatch grep
  yields a one-line per-iteration summary), and verifies the result
  file before branching.
- The implementation call writes `/tmp/ralph/impl-result.json` with one
  of two shapes:
  - `{"status":"PR_OPENED","issue":<n>,"pr_number":<m>,"pr_url":...,"branch":...}`
  - `{"status":"AGENT_STUCK","issue":<n>,"reason":"..."}`
- Bash branches on `impl-result.json.status`: `PR_OPENED` →
  `OUTCOME=pr_opened issue=<n> pr=<m>`; `AGENT_STUCK` →
  `OUTCOME=agent_stuck issue=<n>`. Any other status, missing output,
  or invalid JSON aborts with exit 3 — the EC2 instance still
  terminates via the cloud-init EXIT trap.
- The PR body carries an HTML-comment marker
  `<!-- ralph-launch: <RALPH_LAUNCH_TAG> -->` (defaults to the EC2
  instance id, set in `lib/cloud-init/bootstrap.sh`). Slice 9's
  launcher post-hoc check uses this to correlate when the EC2 was
  hard-killed before recording state.
- `agent-stuck` escape: the prompt instructs the impl call to
  self-stop when ANY of (>3 build/test fix iterations on the same
  failure surface) OR (>15 file edits without a green build) OR
  (self-judged futility) hits. On stuck: the source issue gets the
  `agent_stuck_label` label (default `agent-stuck`), no PR is opened,
  and `impl-result.json` records `status=AGENT_STUCK`.
- The launcher embeds `prompts/implementation.md` into the rendered
  user-data alongside the discovery prompt and exports
  `RALPH_IMPLEMENTATION_PROMPT=/opt/ralph/prompts/implementation.md`.

Slice 7 — discovery call:

- [`prompts/discovery.md`](prompts/discovery.md) — generic discovery
  prompt template. Target context (repo, default branch, work dir,
  build/test commands, branch prefix, optional `prompt_extensions.discovery`)
  is injected via `{{...}}` placeholders at render time; the template
  itself contains zero target-specific identifiers.
- [`lib/ec2-orchestrator.sh`](lib/ec2-orchestrator.sh) — `orch::run`
  now fires the real discovery call: renders the template, invokes
  `claude --print` (with `--permission-mode bypassPermissions` by
  default; override via `RALPH_CLAUDE_FLAGS`), wraps the call in
  `PHASE_START phase=discovery` / `PHASE_END phase=discovery duration_s=...`
  markers, and verifies the four output files exist before branching.
  Each invocation is a fresh claude session (`memory` MCP excluded by
  slice 6's MCP set).
- The discovery call writes four files under `$RALPH_OUT_DIR`
  (default `/tmp/ralph/`):
  - `decision.json` — `status` (`PICKED` | `NONE` | `ALL_BLOCKED`),
    picked issue number, reasoning.
  - `issue.json` — full `gh issue view --json ...` payload of the
    picked issue (or `{}` for non-PICKED).
  - `crafted-prompt.md` — implementation prompt for slice 8, with
    target conventions surfaced from the target's `CLAUDE.md`,
    `AGENTS.md`, `CONTEXT.md`, and any `docs/adr/*` files.
  - `milestone-log.json` — `{milestone, log_issue}` pointing at the
    `[log] <milestone>` issue (find-or-create) for cross-iteration
    learnings.
- Bash branches on `decision.json.status`: `NONE` → `OUTCOME=no_work`,
  `ALL_BLOCKED` → `OUTCOME=all_blocked`, `PICKED` → `OUTCOME=picked issue=<n>`
  (slices 8/9 plug in here). Any other status, missing output file,
  or invalid JSON aborts with exit 3 — the EC2 instance still
  terminates via the cloud-init EXIT trap.
- The launcher embeds `prompts/discovery.md` into the rendered
  user-data via a quoted heredoc and exports
  `RALPH_DISCOVERY_PROMPT=/opt/ralph/prompts/discovery.md`, so the
  prompt template ships alongside the lib bundle without a network
  fetch.

Slice 6 — ec2-bootstrap (deps, secrets, fresh clone, hello orchestrator):

- [`lib/cloud-init/bootstrap.sh`](lib/cloud-init/bootstrap.sh) — slice 6's
  cloud-init payload. Runs once on first boot. Installs OS dependencies
  (Node 20, .NET 10 SDK via `dotnet-install.sh`, `gh`, Docker, `uv`,
  `claude` CLI, plus `git`, `jq`, and `yq`). Configures the five MCPs the
  harness uses (`serena`, `morph-mcp`, `context7`, `github`,
  `sequential-thinking`); the `memory` MCP is intentionally NOT added so
  every iteration starts with fresh context. Fetches the GitHub PAT and
  the Claude OAuth credential from SSM SecureString
  (`/ralph/github-pat`, `/ralph/claude-oauth-credential`) into mode-0600
  files at their consumer's expected on-disk locations; never echoes the
  values. Clones the target repo fresh on its resolved default branch
  (`gh repo view --json defaultBranchRef`, no `main`/`master` assumption).
  Runs safety guards (on default branch, clean working tree, origin
  matches `RALPH_TARGET_REPO`). Validates `.ralph/config.yaml` via
  `tcs::validate`. Hands off to `orch::run`. Ships stdout to CloudWatch
  (`/ralph/main`, stream-per-instance) and runs `shutdown -h now` via a
  bash `trap EXIT` so the box terminates on any exit (success or failure).
- `lib/ec2-orchestrator.sh` — sourceable shell module defining
  `orch::run`. Slice 6 shipped a stub; slice 7 replaces it with the
  real discovery call (see above). Slices 8/9 plug in implementation
  and review after the `PICKED` branch.
- The launcher renders one self-contained user-data script by
  concatenating `lib/target-config-schema.sh`, `lib/ec2-orchestrator.sh`,
  and `lib/cloud-init/bootstrap.sh` after a small env shim that exports
  the five required runtime knobs (`RALPH_TARGET_REPO`,
  `RALPH_AWS_REGION`, `RALPH_GITHUB_TOKEN_SSM_KEY`,
  `RALPH_CLAUDE_OAUTH_SSM_KEY`, `RALPH_LOG_GROUP`). No SSH at any layer;
  SSM Session Manager is the only debug entry point.

```sh
# Fire one EC2 (slice 6 ec2-bootstrap, stub orchestrator):
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

# Fire one throwaway EC2 instance (slice 6 ec2-bootstrap, stub orchestrator):
RALPH_TARGET_REPO=owner/target ./bin/fire.sh

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
