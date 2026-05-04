# ralph-harness

Throwaway-EC2 loop that picks one `ready-for-agent` GitHub issue, implements it
on a fresh branch, opens a PR, and incorporates one auto-review pass — then
terminates.

Generic. Target repo + target-specific config supplied at runtime.

Status: iteration 1, in progress (single-fire from laptop). See issue #1 for
the PRD and the open issues for the slice plan.

## Out of scope (iteration 1)

Iteration 1 is single-fire-from-laptop and intentionally minimal. The
following are deferred to later iterations:

- **Iteration 2 — management EC2.** A long-lived management box that
  schedules `fire.sh` itself on a cron so the laptop stops being in the
  loop. Reuses the slice 5 launcher and the slice 6 cloud-init module
  unchanged.
- **Iteration 2 — Lambda janitor.** Out-of-band sweeper that
  force-terminates any `Project=ralph` EC2 still running past
  `MaxLifetimeMin`, defending against a launcher process killed before its
  ceiling fires.
- **Iteration 3 — custom AMI.** Bake the dependency install (Node, .NET,
  `gh`, Docker, `uv`, `claude`, `jq`, `yq`) so cold-start drops from minutes
  to seconds. Iteration 1 installs at boot via `dotnet-install.sh` etc.
- **Iteration 3 — spot + ARM (`t4g`).** Iteration 1 fires
  `m7a.xlarge` on-demand for predictability under the wall-clock backstop.
- **Iteration 3 — multi-target dispatch.** One run, one target. Routing
  across multiple target repos is deferred.
- **Iteration 3 — observability dashboard.** Iteration 1 ships
  per-instance CloudWatch streams plus the milestone-log GitHub issue
  (caveman-format). A grafana/CW-dashboard view is later.

## Architecture: iteration-2-extensible

The slice 5 launcher (`lib/fire-launcher.sh`) and slice 6 cloud-init module
(`lib/cloud-init/bootstrap.sh`) are written so the iteration-2 management
EC2 can call `fire::run` exactly the way the laptop does today. No core
script needs a rewrite to move the trigger off the laptop — the management
box just needs the same env (`RALPH_TARGET_REPO`, IAM permissions for the
launcher) and a cron entry. See [`docs/smoke-test.md`](docs/smoke-test.md)
for the manual end-to-end runbook iteration 2 will automate.

## OAuth-vs-API-key migration footnote

Iteration 1 ships **OAuth-via-Keychain**. The EC2 worker authenticates to
Claude using the OAuth credential synced from the operator's macOS Keychain
into SSM (slice 4). Switching to a long-lived **API key** is a one-file
change in `lib/cloud-init/bootstrap.sh` (the `boot__fetch_secrets` step):
swap the SSM key, drop the credential file at the API-key consumer's
expected location instead. No other module changes. Tracked as iteration-2
work in issue #7.

OAuth caveats that apply today (and will go away if you migrate to an API
key):

- **Plan limits.** The EC2 worker burns the engineer's Claude plan limits
  on every run.
- **Rotation.** Each desktop `claude /login` may invalidate the prior
  refresh token. Re-run `ralph-sync-credential` immediately after every
  login, or the worker will fail at the first `claude --print` call.
- **Concurrent use unverified.** Simultaneous use of the same OAuth
  credential by the desktop app and an EC2 worker is not validated.
  Assume one active consumer at a time.

## Public-safe

This repository contains zero target-specific identifiers. Every target knob is
supplied at runtime via the target repo's `.ralph/config.yaml` and via
environment variables / SSM. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
contract.

## What's here today

Slice 10 — end-to-end smoke-test runbook (HITL):

- [`docs/smoke-test.md`](docs/smoke-test.md) — operator-driven runbook
  that exercises the full chain on a fresh AWS account: `bootstrap-aws` →
  `sync-credential` → seed PAT → `fire` → tail CloudWatch → verify PR →
  verify cleanup. Acceptance signal is "every phase reached `PHASE_END`
  and the instance is `terminated`."

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

Slice 3 — aws-bootstrap (TS, slice-4 port):

- [`src/lib/aws-bootstrap.ts`](src/lib/aws-bootstrap.ts) — idempotent
  `ensure*` functions for every AWS-side resource the harness needs (KMS
  alias `alias/ralph`, SSM SecureString placeholders, EC2 IAM role +
  instance profile with minimum-scope inline policy, security group in the
  default VPC, CloudWatch log group) plus the target-side `agent-stuck`
  label. Implemented over the AWS SDK v3 clients (`@aws-sdk/client-{kms,ssm,iam,ec2,cloudwatch-logs,sts}`).
- `ralph-bootstrap-aws` (`src/bin/ralph-bootstrap-aws.ts`) — single-shot
  CLI: reads config from env, ensures every resource, second run is a
  clean no-op. Region is forced to `eu-central-1`.

Slice 5 — fire-launcher (single-fire EC2 + CloudWatch streaming):

- [`lib/fire-launcher.sh`](lib/fire-launcher.sh) — fires one throwaway EC2
  in `eu-central-1` (`m7a.xlarge`, 30 GB gp3, AL2023 from public SSM AMI
  parameter, default-VPC public subnet, auto-assigned public IP, IMDSv2
  required) using the bootstrapped IAM instance profile and security group.
  Tags every instance + volume `Project=ralph` plus a UTC `LaunchedAt`
  timestamp and `MaxLifetimeMin`. Launches with
  `--instance-initiated-shutdown-behavior terminate`, then polls
  `describe-instances` until `terminated`. On the 75-minute ceiling the
  launcher force-`terminate-instances` and exits non-zero.
- [`bin/fire.sh`](bin/fire.sh) — single-shot launcher CLI.

Slice 9 — review call (post-PR) + post-hoc agent-stuck detection:

- [`prompts/review.md`](prompts/review.md) — generic review prompt
  template. Target context (repo, default branch, work dir, build/test
  commands, picked issue number, PR number, PR branch, configured
  `review_bot.username` and `.source`, optional
  `prompt_extensions.review`) is injected via `{{...}}` placeholders;
  the template itself contains zero target-specific identifiers.
- `lib/ec2-orchestrator.sh` — `orch::run` now chains a review call
  onto the `PR_OPENED` branch from slice 8: bash `sleep
  RALPH_REVIEW_WAIT_SEC` (default `600`s — the configured external
  review bot's window), render `prompts/review.md`, invoke
  `claude --print`, wrap the call in
  `PHASE_START phase=review issue=<n> pr=<m>` /
  `PHASE_END phase=review duration_s=… status=…` markers (status
  comes from the result file), verify `/tmp/ralph/review-result.json`,
  branch on its `status`. Right after the discovery `PICKED` branch
  the orchestrator emits a stable `PICKED_ISSUE=<n>` marker so the
  launcher's post-hoc check can correlate hard-killed instances back
  to a source issue.
- The review call writes `/tmp/ralph/review-result.json` with one of
  two shapes:
  - `{"status":"NO_REVIEW","reason":"…"}` — no comments / reviews
    from the configured `review_bot.username` (with matching
    `review_bot.source`) within the 10-minute window. No revision,
    no caveman log entry, no state mutation.
  - `{"status":"REVISION_APPLIED","issue":<n>,"pr_number":<m>,"summary":"…","gotcha":"…"}`
    — exactly ONE revision pass: the call addresses the configured
    bot's verdict, runs build + test until green, commits with a
    `review: address …` message, and pushes to the same PR branch.
    No follow-up rounds, no agent-vs-agent ping-pong.
- Bash branches on `review-result.json.status`: `NO_REVIEW` →
  `OUTCOME=pr_opened issue=<n> pr=<m> review=none`; `REVISION_APPLIED`
  → `OUTCOME=pr_opened issue=<n> pr=<m> review=revised` and one
  caveman-format comment is appended to the milestone-log issue via
  `gsm::append_caveman_log` (from `lib/github-state-mutator.sh`,
  bundled into the EC2 user-data alongside the orchestrator).
- Multi-reviewer case: only the configured `review_bot` is consulted;
  Copilot, humans, and other bots on the same PR are ignored.
- `lib/fire-launcher.sh` — embeds `prompts/review.md` alongside
  discovery + implementation, exports
  `RALPH_REVIEW_PROMPT=/opt/ralph/prompts/review.md`, and bundles
  `lib/github-state-mutator.sh` into the user-data so the orchestrator
  can call `gsm::append_caveman_log` on the worker. After
  `wait_for_terminated` (regardless of clean exit or wall-clock breach)
  the launcher runs a post-hoc agent-stuck check from the laptop:
  - List target-repo PRs whose body contains
    `<!-- ralph-launch: <RALPH_LAUNCH_TAG> -->` (the marker the impl
    call embeds). If at least one is found, the run is treated as a
    clean termination.
  - Otherwise, fetch the per-instance CloudWatch stream
    (`aws logs filter-log-events`) for the orchestrator's
    `PICKED_ISSUE=<n>` marker. If found, apply the configured
    `agent_stuck_label` (default `agent-stuck`) to that source issue
    via `gh issue edit`. Covers both wall-clock-killed and
    orchestrator-crashed cases where the impl call could not
    self-label.
  - If neither a tagged PR nor a `PICKED_ISSUE` marker is recoverable,
    the post-hoc check is a no-op (clean exit).

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
RALPH_TARGET_REPO=owner/target ralph-fire

# Tail the per-instance CloudWatch stream:
aws --region eu-central-1 logs tail /ralph/main \
    --log-stream-names <i-...> --follow
```

Slice 4 — operator helper CLIs (TS, macOS-only Keychain syncer):

- [`src/lib/credential-syncer.ts`](src/lib/credential-syncer.ts) — reads
  the `Claude Code-credentials` entry from the macOS Keychain and uploads
  it to the SSM SecureString at `/ralph/claude-oauth-credential`
  (overridable via `RALPH_CLAUDE_OAUTH_SSM_KEY`), encrypted under
  `alias/ralph`.
- `ralph-sync-credential` (`src/bin/ralph-sync-credential.ts`) — thin CLI
  wrapper. Region is forced to `eu-central-1`. The credential is passed
  to `@aws-sdk/client-ssm` as the request body of `PutParameter`, so it
  is never visible on any process's argv and is never echoed in info or
  error output.
- `ralph-sync-github-pat` — net-new operator CLI: reads a GitHub PAT
  from stdin and uploads it to the SSM SecureString at `/ralph/github-pat`
  (overridable via `RALPH_GITHUB_TOKEN_SSM_KEY`). Pass the token on stdin
  only — argv is rejected.
- `ralph-tail-logs` — thin wrapper around `aws logs tail` that defaults
  to `/ralph/main` and the worker's per-instance stream.

Run after every desktop `claude /login`:

```sh
ralph-sync-credential
# or with a custom key:
RALPH_CLAUDE_OAUTH_SSM_KEY=/ralph/claude-oauth-credential ralph-sync-credential
```

Caveats:

- **Rotation:** every desktop `claude /login` may invalidate the prior
  refresh token. Re-run `ralph-sync-credential` immediately after each
  login so the EC2 worker picks up the fresh credential.
- **Concurrent use unverified:** simultaneous use of the same credential by
  the desktop app and an EC2 worker has not been validated; assume one
  active consumer at a time.
- **Plan limits:** the EC2 worker burns the engineer's Claude plan limits
  while running.
- **OAuth-vs-API-key:** iteration 1 ships OAuth-via-Keychain. Switching to a
  long-lived API key is a one-file change in the future `ec2-bootstrap`
  module (see issue #7).

[`src/`](src/) holds the TS modules and bin entries with co-located vitest
tests (`*.test.ts`). Run with `npm test`.

```sh
# Validate a config file by hand:
ralph-validate-config path/to/.ralph/config.yaml

# Manually swap a label on a sandbox repo:
ralph-gsm swap-label owner/sandbox 1 ready-for-agent ready-for-human

# Bootstrap AWS resources for a target repo (idempotent):
RALPH_TARGET_REPO=owner/target ralph-bootstrap-aws

# Sync the macOS Keychain credential into SSM (re-run after every claude /login):
ralph-sync-credential

# Seed the GitHub PAT into SSM (one-time):
echo "$GITHUB_PAT" | ralph-sync-github-pat

# Fire one throwaway EC2 instance (full discovery → impl → review chain):
RALPH_TARGET_REPO=owner/target ralph-fire

# Run the test suite:
npm test
```

Dependencies (operator side): Node ≥ 24 and the harness installed globally
(`npm install -g @unimatrix27/ralph-harness@1.0.0`), plus `jq`, `gh`, and
`aws` CLI v2. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for install hints.

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
