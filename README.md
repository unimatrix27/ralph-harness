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

[`tests/`](tests/) holds bats-core tests with yaml fixtures and a stubbed
`gh` binary on `PATH` for the github-state-mutator suite.

```sh
# Validate a config file by hand:
./bin/load-config path/to/.ralph/config.yaml

# Manually swap a label on a sandbox repo:
./bin/gsm swap-label owner/sandbox 1 ready-for-agent ready-for-human

# Run the test suite:
bats tests/
```

Dependencies: `yq` (mikefarah/yq v4), `jq`, `gh`, and `bats-core`. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for install hints.

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
