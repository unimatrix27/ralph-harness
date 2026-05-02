# Contributing to ralph-harness

## Public-safe contract (read this first)

**No target-specific identifiers in this repository, ever.** This includes:

- organization or company names
- repository names of any specific target
- product, service, brand, or domain-specific terms tied to a particular target
- usernames or email addresses tied to a specific target's people or bots
- specific URLs, hostnames, or AWS account IDs
- copy-pasted code, prompts, or fixtures that name a specific target

The harness is generic by design: every target-specific knob is supplied at
runtime through the target repository's `.ralph/config.yaml` (see
[`docs/config-schema.md`](docs/config-schema.md)) and through environment
variables / SSM parameters. If you find yourself needing to commit something
target-specific to make a change land — stop and reshape the change so the
target detail moves into config instead.

PR reviewers must reject any change that introduces a target-specific
identifier. There is no automated check yet; this is enforced by review and by
the rule above. If you spot an existing leak, open an issue or PR to remove it.

## Repository layout

```
bin/                 user-facing CLI entry points
lib/                 sourceable bash modules
docs/                schema and design docs
tests/               bats-core tests
tests/fixtures/      yaml fixtures for the tests
.ralph/              (target repos only — not used by the harness itself)
```

## Development dependencies

- `bash` 4+ (or recent macOS bash; the modules assume `[[`-style conditionals)
- [`yq`](https://github.com/mikefarah/yq) v4 (the Go binary by mikefarah)
- `jq` (used by `gh --jq` in the github-state-mutator module)
- `gh` (GitHub CLI, authenticated for any target repo you mutate manually)
- [`bats-core`](https://github.com/bats-core/bats-core) for tests

On macOS:

```sh
brew install yq jq gh bats-core
```

On Debian/Ubuntu:

```sh
sudo apt-get install bats jq gh
# yq via the Go release tarball or `snap install yq`
```

## Running the tests

```sh
bats tests/
```

All tests must pass before opening a PR.

## Style

- Bash modules: `set -euo pipefail` only in scripts under `bin/`, never in
  files under `lib/` (a sourced library must not change the caller's shell
  options).
- Module-private helpers are named `tcs::__name`; public functions are
  `tcs::name` (replace `tcs` with the module's prefix).
- Errors go to stderr via the module's `__err` helper and are prefixed with the
  module name so users can tell where a failure came from.
- Exit codes are documented at the top of each module so callers can branch on
  them.

## Adding a new module

1. Add `lib/<module>.sh` with a header comment that documents:
   - what the module does in one paragraph
   - the public function signatures
   - the exit-code contract
   - external dependencies
2. Add a `bin/` CLI wrapper if the module is useful from the command line.
3. Add bats tests under `tests/` and fixtures under `tests/fixtures/`.
4. Update `README.md` and the relevant doc under `docs/` if the module adds
   user-visible surface area.
