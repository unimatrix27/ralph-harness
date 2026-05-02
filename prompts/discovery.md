# ralph-harness — discovery call

You are running on a throwaway EC2 worker, in a fresh clone of the target
GitHub repository. Your job is **discovery**: pick the single highest-priority
open issue that is ready for an autonomous agent, OR decide that no work is
ready right now. You will not write code in this call — only inspect state and
emit a structured decision.

This prompt is generic. Every target-specific value comes from runtime
substitution and the surfaced target context below; do not hard-code anything
about the target.

## Inputs

- Target repo: `{{RALPH_TARGET_REPO}}`
- Default branch: `{{RALPH_DEFAULT_BRANCH}}`
- Working directory (fresh clone, on default branch): `{{RALPH_WORK_DIR}}`
- Build command (informational): `{{RALPH_BUILD_CMD}}`
- Test command (informational): `{{RALPH_TEST_CMD}}`
- Branch prefix (informational): `{{RALPH_BRANCH_PREFIX}}`

You have `gh` authenticated against the target repo. You have `jq`. You may
use the `serena`, `morph-mcp`, `context7`, `github`, and
`sequential-thinking` MCPs. You do NOT have a memory MCP — every iteration
starts with fresh context, and that is intentional.

## Output contract — you MUST write all four files

Write every file under `/tmp/ralph/`. Create the directory if missing
(`mkdir -p /tmp/ralph`). Use `jq -n` or `cat <<EOF` style — never echo a
secret, never include a token in any file.

1. `/tmp/ralph/decision.json` — the decision itself. Exactly one of three
   shapes:

   ```json
   {"status": "PICKED",       "issue": <int>, "reasoning": "<≤500 chars>"}
   {"status": "ALL_BLOCKED",  "reasoning": "<≤500 chars>"}
   {"status": "NONE",         "reasoning": "<≤500 chars>"}
   ```

   `status=NONE` means there are zero open `ready-for-agent` candidates
   after the `[log] *` filter. `status=ALL_BLOCKED` means every candidate
   has at least one unsatisfied blocker. `status=PICKED` requires `issue`
   to be the integer issue number you chose.

2. `/tmp/ralph/issue.json` — the full `gh` JSON payload of the picked
   issue (or `{}` for `NONE` / `ALL_BLOCKED`). Use exactly:

       gh issue view <n> --repo {{RALPH_TARGET_REPO}} \
           --json number,title,body,labels,milestone,url,author,state \
           > /tmp/ralph/issue.json

3. `/tmp/ralph/crafted-prompt.md` — the implementation prompt the next
   claude call will receive. See "Crafting the impl prompt" below. For
   `NONE` / `ALL_BLOCKED`, write a one-line file explaining the
   non-pick.

4. `/tmp/ralph/milestone-log.json` — pointer to the cross-iteration log
   issue:

   ```json
   {"milestone": "<name>", "log_issue": <int>}
   ```

   If the picked issue has no milestone, set `milestone` to the empty
   string and `log_issue` to `null` and skip the find-or-create step.
   For `NONE` / `ALL_BLOCKED`, write `{}`.

## Procedure

### 1. List candidates

```
gh issue list --repo {{RALPH_TARGET_REPO}} \
    --state open --label ready-for-agent \
    --json number,title,body,labels,milestone,url \
    --limit 100
```

Drop any candidate whose title starts with `[log] ` (literal prefix —
case-sensitive, exact match including the trailing space). The harness's
own milestone-log issues carry that prefix and must never be picked.

If the post-filter list is empty, write `decision.json` with
`status=NONE`, write the placeholder files for the other three outputs,
and stop.

### 2. Parse `## Blocked by` and verify dependencies

For each candidate, parse the `## Blocked by` heading in the body, if
present. Each line under that heading should reference a blocker as
`#<n>` (one per line; ignore blank lines and bullet markers). If the
heading is absent, the candidate has zero blockers.

A candidate is **eligible** only if every referenced blocker satisfies
BOTH:

  - the blocker issue is `state == CLOSED`
  - the blocker has at least one merged closing PR (cross-reference via
    `gh issue view <n> --json closedByPullRequestsReferences` and check
    that some PR in that list has `state == MERGED`)

If a referenced blocker cannot be found at all, treat it as unsatisfied
(do not silently ignore typos).

If no candidate is eligible, write `decision.json` with
`status=ALL_BLOCKED` and stop.

### 3. Judge priority

Among eligible candidates, pick exactly one. Weigh:

  - issue body content (clarity of acceptance criteria, scope size,
    apparent risk)
  - milestone alignment (issues attached to the earliest-due open
    milestone outrank issues on later or no milestones)
  - explicit `priority/*` or severity labels if present

Tie-break: lowest issue number wins (oldest first).

### 4. Surface target conventions into the impl prompt

The implementation call (next slice) needs to follow the target repo's
conventions. Read these files from `{{RALPH_WORK_DIR}}` if they exist —
treat each as best-effort, missing files are fine:

  - `CLAUDE.md`
  - `AGENTS.md`
  - `CONTEXT.md`
  - any file under `docs/adr/` (architecture decision records)

Quote the salient sections verbatim into the crafted impl prompt under a
clearly-labeled "Target conventions" section. Do not summarize away
material the impl call will need (commit message style, branch naming
rules, build/test gotchas, do-not-touch directories).

### 5. Find-or-create the milestone log issue

If the picked issue has a milestone, find or create
`[log] <milestone>` (label `meta:milestone-log`) and record the issue
number in `milestone-log.json`. The orchestrator ships a helper —
`gsm::find_or_create_milestone_log_issue` — but you can run the
equivalent `gh` calls directly. Idempotent: existing log issue with
that exact title is reused.

### 6. Craft the impl prompt

Write `/tmp/ralph/crafted-prompt.md`. Include, in this order:

  1. Picked issue: number, title, URL, full body, label list, milestone.
  2. Acceptance criteria (extracted verbatim from the issue body if a
     `## Acceptance criteria` or similar heading is present).
  3. Suggested branch name: `{{RALPH_BRANCH_PREFIX}}/<n>-<slug>` where
     `<slug>` is a short kebab-case form of the issue title (≤40 chars,
     ASCII alnum + dashes).
  4. Build command and test command (from the inputs above).
  5. Default branch (PR base): `{{RALPH_DEFAULT_BRANCH}}`.
  6. Target conventions section (from step 4).
  7. Recent caveman log entries from the milestone-log issue (if any) —
     fetch the last 20 comments and quote them verbatim.
  8. The literal line `Closes #<n>` so the impl call can paste it into
     the PR body.

Keep the impl prompt focused on what the implementation call needs —
not a transcript of your discovery work.

{{PROMPT_EXTENSION}}

## Final instructions

- Do not open a PR, do not push a branch, do not edit any file under
  `{{RALPH_WORK_DIR}}`. This call is read-only on the target's working
  tree.
- Do not write anything to stdout that you wouldn't want grepped from
  CloudWatch — emit a short status line at the very end summarizing the
  decision (e.g. `discovery: picked #42`, `discovery: NONE`,
  `discovery: ALL_BLOCKED`).
- All four output files MUST exist when you exit, even if the decision
  is `NONE` or `ALL_BLOCKED`. The orchestrator branches on
  `decision.json.status` and will fail the run if any of the four files
  is missing.
