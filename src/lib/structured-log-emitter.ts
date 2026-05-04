// structured-log-emitter — formats the CloudWatch markers the harness emits
// at every phase boundary. The wire format is byte-identical to iteration 1's
// ec2-orchestrator.sh output so existing CloudWatch Insights queries / smoke-
// test grep lines keep working unchanged.
//
// Markers:
//   PHASE_START phase=<discovery>       ts=<iso> target=<repo>
//   PHASE_START phase=<implementation>  ts=<iso> issue=<n>
//   PHASE_START phase=<review>          ts=<iso> issue=<n> pr=<m>
//   PHASE_END   phase=<discovery>       duration_s=<n> ts=<iso>
//   PHASE_END   phase=<implementation>  duration_s=<n> issue=<n> status=<s> ts=<iso>
//   PHASE_END   phase=<review>          duration_s=<n> issue=<n> pr=<m> status=<s> ts=<iso>
//   PICKED_ISSUE=<n>
//   OUTCOME=no_work
//   OUTCOME=all_blocked
//   OUTCOME=agent_stuck issue=<n>
//   OUTCOME=pr_opened issue=<n> pr=<m> review=<none|revised>
//
// The iteration-1 timestamps come from `date -u +%FT%TZ`, e.g.
// `2026-05-04T11:43:57Z`. We reproduce that via `nowUtc()` rather than
// taking it as a free parameter — keeps callers honest and tests
// deterministic via the injectable `clock` argument.

export const MODULE_PREFIX = "structured-log-emitter";

export type Phase = "discovery" | "implementation" | "review";

export type Outcome =
  | { kind: "no_work" }
  | { kind: "all_blocked" }
  | { kind: "agent_stuck"; issue: number }
  | {
      kind: "pr_opened";
      issue: number;
      pr: number;
      review: "none" | "revised";
    };

export type ImplementationStatus = "PR_OPENED" | "AGENT_STUCK" | "unknown";
export type ReviewStatus = "NO_REVIEW" | "REVISION_APPLIED" | "unknown";

export type Clock = () => Date;

export const realClock: Clock = () => new Date();

// nowUtc — formats a Date as `YYYY-MM-DDTHH:MM:SSZ`, matching iteration-1's
// `date -u +%FT%TZ`. We can NOT use `Date.toISOString()` directly: it emits
// fractional milliseconds (`.123Z`), which would break byte-identity with
// the bash port.
export function nowUtc(clock: Clock = realClock): string {
  const d = clock();
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

export interface PhaseStartArgs {
  phase: Phase;
  ts: string;
  target?: string;
  issue?: number;
  pr?: number;
}

export function phaseStart(args: PhaseStartArgs): string {
  switch (args.phase) {
    case "discovery":
      return `PHASE_START phase=discovery ts=${args.ts} target=${args.target ?? "unknown"}`;
    case "implementation":
      return `PHASE_START phase=implementation ts=${args.ts} issue=${requireNumber(args.issue, "issue")}`;
    case "review":
      return `PHASE_START phase=review ts=${args.ts} issue=${requireNumber(args.issue, "issue")} pr=${requireNumber(args.pr, "pr")}`;
  }
}

export interface PhaseEndArgs {
  phase: Phase;
  durationSec: number;
  ts: string;
  issue?: number;
  pr?: number;
  status?: string;
}

export function phaseEnd(args: PhaseEndArgs): string {
  switch (args.phase) {
    case "discovery":
      return `PHASE_END phase=discovery duration_s=${args.durationSec} ts=${args.ts}`;
    case "implementation":
      return (
        `PHASE_END phase=implementation duration_s=${args.durationSec}` +
        ` issue=${requireNumber(args.issue, "issue")}` +
        ` status=${args.status ?? "unknown"}` +
        ` ts=${args.ts}`
      );
    case "review":
      return (
        `PHASE_END phase=review duration_s=${args.durationSec}` +
        ` issue=${requireNumber(args.issue, "issue")}` +
        ` pr=${requireNumber(args.pr, "pr")}` +
        ` status=${args.status ?? "unknown"}` +
        ` ts=${args.ts}`
      );
  }
}

export function pickedIssue(issue: number): string {
  return `PICKED_ISSUE=${issue}`;
}

export function outcome(o: Outcome): string {
  switch (o.kind) {
    case "no_work":
      return "OUTCOME=no_work";
    case "all_blocked":
      return "OUTCOME=all_blocked";
    case "agent_stuck":
      return `OUTCOME=agent_stuck issue=${o.issue}`;
    case "pr_opened":
      return `OUTCOME=pr_opened issue=${o.issue} pr=${o.pr} review=${o.review}`;
  }
}

// ---- emitter wrapper -------------------------------------------------

export type Sink = (line: string) => void;

export const stdoutSink: Sink = (line) => process.stdout.write(`${line}\n`);

export class Emitter {
  constructor(
    private readonly sink: Sink = stdoutSink,
    private readonly clock: Clock = realClock,
  ) {}

  ts(): string {
    return nowUtc(this.clock);
  }

  emit(line: string): void {
    this.sink(line);
  }

  start(args: Omit<PhaseStartArgs, "ts">): string {
    const line = phaseStart({ ...args, ts: this.ts() });
    this.sink(line);
    return line;
  }

  end(args: Omit<PhaseEndArgs, "ts">): string {
    const line = phaseEnd({ ...args, ts: this.ts() });
    this.sink(line);
    return line;
  }

  picked(issue: number): string {
    const line = pickedIssue(issue);
    this.sink(line);
    return line;
  }

  outcome(o: Outcome): string {
    const line = outcome(o);
    this.sink(line);
    return line;
  }
}

function requireNumber(v: number | undefined, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${MODULE_PREFIX}: ${name} is required`);
  }
  return v;
}
