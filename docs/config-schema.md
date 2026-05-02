# `.ralph/config.yaml` schema

Every target repository that is driven by `ralph-harness` must commit a file at
`.ralph/config.yaml` describing the target-specific knobs the harness needs at
runtime. The harness itself ships zero target-specific code or identifiers; this
file is the only place where target shape leaks in.

The harness loads this file with `lib/target-config-schema.sh` (CLI:
`bin/load-config <path>`). On any error the loader exits non-zero with a
human-readable message; iteration 1 of the harness fails fast on
misconfiguration rather than silently no-op'ing.

## Top-level keys

| Key                  | Required | Type    | Purpose                                                                                                                |
| -------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `build_cmd`          | yes      | string  | Shell command run inside a fresh clone of the target repo to build it. Non-zero exit means build failure.              |
| `test_cmd`           | yes      | string  | Shell command run inside a fresh clone to run the target's test suite. Non-zero exit means test failure.               |
| `branch_prefix`      | yes      | string  | Prefix for branches the harness creates (e.g. `ralph` → `ralph/<n>-<slug>`). Must contain no whitespace and no `/`.    |
| `review_bot`         | yes      | mapping | Identity of the auto-review bot whose review the third claude call consumes. See sub-keys below.                       |
| `agent_stuck_label`  | no       | string  | Label name applied to the source issue when the impl call escapes via the stuck-budget path. Defaults to `agent-stuck`. |
| `prompt_extensions`  | no       | mapping | Optional per-phase prompt fragments injected at the end of the harness's base prompts. See sub-keys below.             |

Unknown top-level keys are rejected.

## `review_bot`

| Key        | Required | Type   | Purpose                                                                                              |
| ---------- | -------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `username` | yes      | string | GitHub login of the auto-review bot (e.g. the login that posts the consolidated PR review summary).   |
| `source`   | yes      | string | Where the bot's verdict is read from. One of: `comment` (PR comment), `review` (PR review object).   |

Unknown sub-keys are rejected.

## `prompt_extensions`

Optional. Each sub-key is an additional prompt fragment appended to the matching
phase prompt:

| Key              | Required | Type   | Purpose                                                          |
| ---------------- | -------- | ------ | ---------------------------------------------------------------- |
| `discovery`      | no       | string | Extra instructions appended to the discovery (call 1) prompt.    |
| `implementation` | no       | string | Extra instructions appended to the implementation (call 2) prompt. |
| `review`         | no       | string | Extra instructions appended to the review (call 3) prompt.       |

Unknown sub-keys are rejected.

## Example — minimal

```yaml
build_cmd: "make build"
test_cmd: "make test"
branch_prefix: "ralph"
review_bot:
  username: "claude"
  source: "comment"
```

## Example — full

```yaml
build_cmd: "./scripts/build.sh"
test_cmd: "./scripts/test.sh"
branch_prefix: "ralph"
review_bot:
  username: "claude"
  source: "comment"
agent_stuck_label: "agent-stuck"
prompt_extensions:
  discovery: |
    Prefer issues tagged `priority:high`.
  implementation: |
    Follow the conventions documented in CONTEXT.md.
  review: |
    Address every blocking comment; ignore nits.
```

## Validation rules summary

- File must exist and be readable.
- File must parse as YAML and the top level must be a mapping.
- All required top-level keys must be present.
- No unknown top-level keys.
- All string-typed keys must be non-empty strings.
- `branch_prefix` must contain no `/` and no whitespace.
- `review_bot` must be a mapping with required `username` and `source` (and no other keys); `source` must be `comment` or `review`.
- `prompt_extensions`, if present, must be a mapping; allowed sub-keys are `discovery`, `implementation`, `review`, each a non-empty string.
