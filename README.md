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

## What's here today (slice 1)

- [`docs/config-schema.md`](docs/config-schema.md) — full schema for the
  `.ralph/config.yaml` file every target repo must commit.
- [`lib/target-config-schema.sh`](lib/target-config-schema.sh) — sourceable
  bash module that loads and validates a target repo's `.ralph/config.yaml`.
  Fails loud with a useful message on any error.
- [`bin/load-config`](bin/load-config) — thin CLI over the validator. Exits 0
  on valid input, non-zero on bad input.
- [`tests/`](tests/) — bats-core tests with yaml fixtures.

```sh
# Validate a config file by hand:
./bin/load-config path/to/.ralph/config.yaml

# Run the test suite:
bats tests/
```

Dependencies: `yq` (mikefarah/yq v4) and `bats-core`. See
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
