// github-state-mutator — idempotent wrappers around `gh` for the four state
// mutations the orchestrator needs:
//
//   swapLabel(repo, num, from, to)
//   commentIssue(repo, num, body)
//   findOrCreateMilestoneLogIssue(repo, milestone)  — returns issue number
//   appendCavemanLog(repo, logNum, issueNum, summary, gotcha?)
//
// Idempotency contract (must match lib/github-state-mutator.sh — bash module
// is still sourced by the EC2 orchestrator until slice 5 cuts it over):
//
//   - swapLabel: when the issue already has `to` and not `from`, no `gh issue
//     edit` call is made (verified by the test matrix).
//   - findOrCreateMilestoneLogIssue: a second call with the same milestone
//     name returns the existing issue number without invoking `gh issue
//     create`.
//   - commentIssue / appendCavemanLog are append-only by design — every call
//     posts. The milestone-log workflow relies on this (one comment per
//     iteration). This matches the bash contract; deduping would be a
//     regression for the consumer.
//
// Errors go to stderr via moduleErr() so callers can grep on the prefix.
//
// Exit codes are surfaced by the CLI (ralph-gsm), not this module:
//   0  success
//   2  usage / missing required argument                   (CLI only)
//   non-zero  propagated from gh via GhRunnerError         (CLI only)

import {
  GhRunnerError,
  runGh,
  type GhResult,
} from "./gh-runner.js";

export const MODULE_PREFIX = "github-state-mutator";

export function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

interface IssueViewLabels {
  labels: { name: string }[];
}

interface IssueListItem {
  number: number;
  title: string;
}

// swapLabel — remove `from` if present, add `to` if missing. No gh-edit call
// at all when the target state already matches.
export function swapLabel(
  repo: string,
  num: number,
  from: string,
  to: string,
): void {
  const view = runGh([
    "issue",
    "view",
    String(num),
    "--repo",
    repo,
    "--json",
    "labels",
  ]);

  const parsed = parseLabelsJson(view.stdout, repo, num);
  const names = new Set(parsed.labels.map((l) => l.name));
  const hasFrom = names.has(from);
  const hasTo = names.has(to);

  if (!hasFrom && hasTo) return;

  const args = ["issue", "edit", String(num), "--repo", repo];
  if (hasFrom) args.push("--remove-label", from);
  if (!hasTo) args.push("--add-label", to);

  runGh(args);
}

// commentIssue — post a comment. Append-only (see contract above).
export function commentIssue(repo: string, num: number, body: string): void {
  runGh(["issue", "comment", String(num), "--repo", repo, "--body", body]);
}

// findOrCreateMilestoneLogIssue — find by exact title `[log] <milestone>`
// (filtered to the meta:milestone-log label). Create if missing. Echo the
// issue number.
export function findOrCreateMilestoneLogIssue(
  repo: string,
  milestone: string,
): number {
  const title = `[log] ${milestone}`;

  const list = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    "meta:milestone-log",
    "--state",
    "all",
    "--json",
    "number,title",
    "--limit",
    "100",
  ]);

  const items = parseIssueList(list.stdout, repo);
  const existing = items.find((i) => i.title === title);
  if (existing) return existing.number;

  const body = milestoneLogBody(milestone);
  const create = runGh([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--label",
    "meta:milestone-log",
    "--body",
    body,
  ]);

  return parseIssueNumberFromUrl(create.stdout);
}

// appendCavemanLog — post one caveman-format comment on the milestone-log
// issue. Empty/missing gotcha renders as `-`.
export function appendCavemanLog(
  repo: string,
  logNum: number,
  issueNum: number,
  summary: string,
  gotcha?: string,
): void {
  const g = gotcha && gotcha.length > 0 ? gotcha : "-";
  const line = `#${issueNum} | ${summary} | ${g}`;
  commentIssue(repo, logNum, line);
}

// ---- internals ----

export function milestoneLogBody(milestone: string): string {
  return `This issue is the cross-iteration learnings log for milestone '${milestone}'.

Each ralph-harness implementation iteration appends one comment in caveman format:

    #<issue> | <one-line summary> | <gotcha or '-'>

Do not close manually — the harness reads recent comments here for prior-iteration context.`;
}

function parseLabelsJson(
  stdout: string,
  repo: string,
  num: number,
): IssueViewLabels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      moduleErr(
        `swap_label: could not parse labels for ${repo}#${num}: ${detail}`,
      ),
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { labels?: unknown }).labels)
  ) {
    throw new Error(
      moduleErr(`swap_label: unexpected labels payload for ${repo}#${num}`),
    );
  }
  const rawLabels = (parsed as { labels: unknown[] }).labels;
  const labels: { name: string }[] = [];
  for (const l of rawLabels) {
    if (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string") {
      labels.push({ name: (l as { name: string }).name });
    }
  }
  return { labels };
}

function parseIssueList(stdout: string, repo: string): IssueListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      moduleErr(
        `find_or_create_milestone_log_issue: could not parse issue list for ${repo}: ${detail}`,
      ),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      moduleErr(
        `find_or_create_milestone_log_issue: expected array from gh issue list, got ${typeof parsed}`,
      ),
    );
  }
  const out: IssueListItem[] = [];
  for (const i of parsed) {
    if (
      i &&
      typeof i === "object" &&
      typeof (i as { number?: unknown }).number === "number" &&
      typeof (i as { title?: unknown }).title === "string"
    ) {
      out.push({
        number: (i as { number: number }).number,
        title: (i as { title: string }).title,
      });
    }
  }
  return out;
}

function parseIssueNumberFromUrl(stdout: string): number {
  // `gh issue create` prints the new issue URL on stdout — last path segment
  // is the issue number.
  const trimmed = stdout.trim();
  const tail = trimmed.split("/").pop() ?? "";
  const n = Number.parseInt(tail, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      moduleErr(
        `find_or_create_milestone_log_issue: could not parse issue number from gh stdout: ${trimmed}`,
      ),
    );
  }
  return n;
}

// Re-export so the CLI can use a single import surface.
export { GhRunnerError, runGh };
export type { GhResult };
