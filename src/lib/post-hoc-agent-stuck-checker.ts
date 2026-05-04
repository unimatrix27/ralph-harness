// post-hoc-agent-stuck-checker — slice-9 contract, ported to TS.
//
// After the EC2 instance terminates, the launcher checks whether the
// implementation call left behind a marker:
//
//   - PR on the target repo carrying `<!-- ralph-launch: <tag> -->` in body
//   - or, if no such PR, a `PICKED_ISSUE=<n>` line in the per-instance
//     CloudWatch stream
//
// Outcomes:
//   - PR found              → ClearTermination (the run produced output)
//   - No PR, no picked issue → NoPickedIssueRecoverable (e.g. discovery
//                              returned NONE/ALL_BLOCKED before any work)
//   - No PR, picked issue   → AgentStuckLabelApplied (the launcher labels
//                              the source issue `agent-stuck`)
//
// Composes:
//   gh-runner            — list PRs, edit issue label
//   aws-clients          — CloudWatch FilterLogEventsCommand
//   structured-log-emitter — info-line sink for the diagnostic trail
//
// Failure mode: any read failure (gh auth, CloudWatch transient, missing
// log stream) is treated as "no signal recovered" and the check returns
// without applying a label. The cost of a missed label is a stale
// `ready-for-agent` issue that the next iteration can re-evaluate; the
// cost of a wrong label is operator confusion. Asymmetric, so we err on
// the side of silence.

import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

import type { AwsClients } from "./aws-clients.js";
import { GhRunnerError, runGh } from "./gh-runner.js";
import type { Sink } from "./structured-log-emitter.js";

export const MODULE_PREFIX = "post-hoc-agent-stuck-checker";

export type CheckResult =
  | { kind: "ClearTermination"; prNumber?: number }
  | { kind: "NoPickedIssueRecoverable" }
  | { kind: "AgentStuckLabelApplied"; issue: number };

export interface CheckOptions {
  clients: AwsClients;
  targetRepo: string;
  launchTag: string;
  instanceId: string;
  logGroup: string;
  agentStuckLabel: string;
  info?: Sink; // diagnostic sink — defaults to a no-op
}

const noop: Sink = () => {};

interface PrListItem {
  number: number;
  body: string | null;
}

// findPrWithLaunchTag — list recent PRs (any state) on the target repo
// whose body contains the `ralph-launch: <tag>` marker. Returns the first
// match's PR number, or null. Network/auth failures return null.
export async function findPrWithLaunchTag(
  repo: string,
  launchTag: string,
): Promise<number | null> {
  let parsed: PrListItem[];
  try {
    const r = runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,body",
    ]);
    const data = JSON.parse(r.stdout);
    if (!Array.isArray(data)) return null;
    parsed = data
      .filter(
        (i): i is PrListItem =>
          !!i &&
          typeof i === "object" &&
          typeof (i as { number?: unknown }).number === "number",
      )
      .map((i) => ({
        number: (i as { number: number }).number,
        body: typeof (i as { body?: unknown }).body === "string"
          ? (i as { body: string }).body
          : null,
      }));
  } catch (err) {
    if (err instanceof GhRunnerError) return null;
    return null;
  }
  const marker = `ralph-launch: ${launchTag}`;
  for (const pr of parsed) {
    if (pr.body && pr.body.includes(marker)) return pr.number;
  }
  return null;
}

// fetchPickedIssue — query CloudWatch for the orchestrator's
// `PICKED_ISSUE=<n>` marker on the per-instance log stream. Returns the
// integer or null on any failure.
export async function fetchPickedIssue(
  clients: AwsClients,
  logGroup: string,
  instanceId: string,
): Promise<number | null> {
  try {
    const r = await clients.logs.send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        logStreamNames: [instanceId],
        filterPattern: '"PICKED_ISSUE="',
      }),
    );
    for (const ev of r.events ?? []) {
      const msg = ev.message ?? "";
      const m = msg.match(/PICKED_ISSUE=(\d+)/);
      if (m && m[1]) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// applyAgentStuckLabel — best-effort `gh issue edit --add-label`. We never
// throw here: a label that was already applied returns non-zero with a
// useful message, but for our purposes the post-condition (label present)
// is what matters, and that's the case whether or not we re-applied.
export function applyAgentStuckLabel(
  repo: string,
  issue: number,
  label: string,
  info: Sink,
): boolean {
  try {
    runGh([
      "issue",
      "edit",
      String(issue),
      "--repo",
      repo,
      "--add-label",
      label,
    ]);
    return true;
  } catch (err) {
    if (err instanceof GhRunnerError) {
      info(
        `${MODULE_PREFIX}: gh issue edit returned ${err.exitCode} (label may already be present)`,
      );
      return false;
    }
    throw err;
  }
}

export async function postHocCheck(
  opts: CheckOptions,
): Promise<CheckResult> {
  const info = opts.info ?? noop;
  const prNumber = await findPrWithLaunchTag(opts.targetRepo, opts.launchTag);
  if (prNumber !== null) {
    info(
      `${MODULE_PREFIX}: PR #${prNumber} carries launch tag ${opts.launchTag} — clean termination`,
    );
    return { kind: "ClearTermination", prNumber };
  }

  const issue = await fetchPickedIssue(
    opts.clients,
    opts.logGroup,
    opts.instanceId,
  );
  if (issue === null) {
    info(
      `${MODULE_PREFIX}: no PR for launch ${opts.launchTag} and no picked issue recoverable from CloudWatch — nothing to label`,
    );
    return { kind: "NoPickedIssueRecoverable" };
  }

  info(
    `${MODULE_PREFIX}: no PR for launch ${opts.launchTag} — applying ${opts.agentStuckLabel} to ${opts.targetRepo}#${issue}`,
  );
  applyAgentStuckLabel(
    opts.targetRepo,
    issue,
    opts.agentStuckLabel,
    info,
  );
  return { kind: "AgentStuckLabelApplied", issue };
}
