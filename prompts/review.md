# ralph-harness — review call

You are running on a throwaway EC2 worker, in a fresh clone of the
target GitHub repository. The implementation call already opened a PR
on this branch for the picked issue. The bash orchestrator slept for
ten minutes before invoking you, to give the configured external
review bot time to post its consolidated verdict on the PR.

Your job in this call is to **fetch the PR feedback, filter it to the
configured review bot, and (if a verdict is present) apply ONE
revision pass — push, then exit**. This is the only revision round.
No follow-up rounds, no polling for newer reviews, no agent-vs-agent
ping-pong.

This prompt is generic. Every target-specific value comes from
runtime substitution; do not hard-code anything about the target.

## Inputs

- Target repo: `{{RALPH_TARGET_REPO}}`
- Default branch (PR base): `{{RALPH_DEFAULT_BRANCH}}`
- Working directory (fresh clone, on default branch): `{{RALPH_WORK_DIR}}`
- Build command: `{{RALPH_BUILD_CMD}}`
- Test command: `{{RALPH_TEST_CMD}}`
- Source issue number: `{{RALPH_ISSUE_NUMBER}}`
- PR number: `{{RALPH_PR_NUMBER}}`
- PR branch: `{{RALPH_PR_BRANCH}}`
- Review bot username: `{{RALPH_REVIEW_BOT_USERNAME}}`
- Review bot source: `{{RALPH_REVIEW_BOT_SOURCE}}` (one of: `comment`, `review`)

You have `gh` authenticated against the target repo. You have `jq`.
You may use the `serena`, `morph-mcp`, `context7`, `github`, and
`sequential-thinking` MCPs. You do NOT have a memory MCP — every
iteration starts with fresh context, and that is intentional.

## Output contract — write `/tmp/ralph/review-result.json`

Exactly one of two shapes. Write this file before you exit, no matter
what happens:

```json
{"status": "NO_REVIEW",        "reason":  "<≤500 chars>"}
{"status": "REVISION_APPLIED", "issue":   <int>, "pr_number": <int>,
                               "summary": "<≤200 chars>",
                               "gotcha":  "<≤200 chars or empty>"}
```

The orchestrator branches on `status`, surfaces the result as the
phase-end status marker for CloudWatch, and on `REVISION_APPLIED`
appends one caveman-format line to the milestone-log issue (via
`gsm::append_caveman_log`) using `summary` and `gotcha`.

## Procedure

### 1. Fetch PR comments + reviews

```
gh pr view {{RALPH_PR_NUMBER}} --repo {{RALPH_TARGET_REPO}} \
    --json comments,reviews \
    > /tmp/ralph/pr-feedback.json
```

### 2. Filter to the configured review bot

`{{RALPH_REVIEW_BOT_SOURCE}}` decides which collection to scan:

  - `comment` — scan `.comments[]` for entries where
    `.author.login == "{{RALPH_REVIEW_BOT_USERNAME}}"`
  - `review`  — scan `.reviews[]`  for entries where
    `.author.login == "{{RALPH_REVIEW_BOT_USERNAME}}"`

ONLY the configured `review_bot` is consulted. Other reviewers
(Copilot, humans, other bots) are out of scope for this call —
ignore them entirely. Do not let a Copilot review prompt a revision.

### 3. No verdict from the configured bot → no-op clean exit

If the filter returns zero entries:

  1. Do NOT push, comment, label, or touch any state.
  2. Write `/tmp/ralph/review-result.json` with `status=NO_REVIEW`
     and a one-line `reason` (e.g.
     `"no comments from <bot> within the 10-minute window"`).
  3. Exit cleanly. The orchestrator skips the caveman log entry on
     `NO_REVIEW`.

### 4. Verdict present → ONE revision pass

Take the most recent matching entry as the review verdict. Check out
the PR branch:

```
cd {{RALPH_WORK_DIR}}
git fetch origin {{RALPH_PR_BRANCH}}
git checkout {{RALPH_PR_BRANCH}}
```

Apply ONE pass that addresses the actionable feedback. Run
`{{RALPH_BUILD_CMD}}` and `{{RALPH_TEST_CMD}}` after each meaningful
edit until both are green. Make one atomic commit (message style:
`review: address <bot> feedback`) and push:

```
git push origin {{RALPH_PR_BRANCH}}
```

DO NOT loop. DO NOT fetch newer reviews after pushing. DO NOT engage
in further rounds. The harness's contract is exactly one revision
round per iteration.

### 5. Write the result file

```
jq -n \
    --argjson n  {{RALPH_ISSUE_NUMBER}} \
    --argjson p  {{RALPH_PR_NUMBER}} \
    --arg     s  "<one-line summary of what changed>" \
    --arg     g  "<one-line gotcha or empty>" \
    '{status:"REVISION_APPLIED", issue:$n, pr_number:$p, summary:$s, gotcha:$g}' \
    > /tmp/ralph/review-result.json
```

{{PROMPT_EXTENSION}}

## Final instructions

- One revision round only. Do not poll for follow-up reviews.
- Never echo a token, the OAuth credential, or any environment value
  beginning with `GITHUB_` / `GH_` / `ANTHROPIC_` to stdout.
  CloudWatch is the surface for these logs.
- Emit a short status line at the very end summarizing what
  happened (e.g. `review: NO_REVIEW`,
  `review: REVISION_APPLIED pr=<m>`).
- `/tmp/ralph/review-result.json` MUST exist when you exit. The
  orchestrator fails the run if it is missing or not valid JSON.
