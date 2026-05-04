// phase-result-schemas — Zod schemas + parser helpers for the four contract
// JSON files the harness writes during a single iteration:
//
//   /tmp/ralph/decision.json         (discovery output)
//   /tmp/ralph/issue.json            (full gh payload of the picked issue)
//   /tmp/ralph/milestone-log.json    (cross-iteration log pointer)
//   /tmp/ralph/impl-result.json      (implementation output)
//   /tmp/ralph/review-result.json    (review output)
//   /tmp/ralph/crafted-prompt.md     (the impl call's input — text, not JSON)
//
// The orchestrator branches on the discriminated `status` field of each
// JSON output. Validation here exists so an off-by-one in claude's output
// surfaces as a typed error in the orchestrator (exit 3, missing/invalid
// contract file) rather than an opaque later crash.
//
// Public surface:
//   DecisionSchema       (PICKED | NONE | ALL_BLOCKED)
//   ImplResultSchema     (PR_OPENED | AGENT_STUCK)
//   ReviewResultSchema   (NO_REVIEW | REVISION_APPLIED)
//   MilestoneLogSchema   ({} | {milestone, log_issue})
//   parseDecision / parseImplResult / parseReviewResult / parseMilestoneLog
//   readDecision / readImplResult / readReviewResult / readMilestoneLog
//
// Parsers throw `SchemaError` on a parse failure with a human-readable
// summary; readers add the file path to the message so a CloudWatch grep
// shows which contract file misbehaved.

import { readFileSync } from "node:fs";

import { z } from "zod";

export const MODULE_PREFIX = "phase-result-schemas";

export class SchemaError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

// ---- Decision -------------------------------------------------------

export const DecisionPickedSchema = z.object({
  status: z.literal("PICKED"),
  issue: z.number().int().positive(),
  reasoning: z.string(),
});

export const DecisionNoneSchema = z.object({
  status: z.literal("NONE"),
  reasoning: z.string(),
});

export const DecisionAllBlockedSchema = z.object({
  status: z.literal("ALL_BLOCKED"),
  reasoning: z.string(),
});

export const DecisionSchema = z.discriminatedUnion("status", [
  DecisionPickedSchema,
  DecisionNoneSchema,
  DecisionAllBlockedSchema,
]);

export type Decision = z.infer<typeof DecisionSchema>;

// ---- Implementation result -----------------------------------------

export const ImplPrOpenedSchema = z.object({
  status: z.literal("PR_OPENED"),
  issue: z.number().int().positive(),
  pr_number: z.number().int().positive(),
  pr_url: z.string().url(),
  branch: z.string().min(1),
});

export const ImplAgentStuckSchema = z.object({
  status: z.literal("AGENT_STUCK"),
  issue: z.number().int().positive(),
  reason: z.string(),
});

export const ImplResultSchema = z.discriminatedUnion("status", [
  ImplPrOpenedSchema,
  ImplAgentStuckSchema,
]);

export type ImplResult = z.infer<typeof ImplResultSchema>;

// ---- Review result -------------------------------------------------

export const ReviewNoReviewSchema = z.object({
  status: z.literal("NO_REVIEW"),
  reason: z.string().optional(),
});

export const ReviewRevisionAppliedSchema = z.object({
  status: z.literal("REVISION_APPLIED"),
  summary: z.string(),
  gotcha: z.string().optional(),
});

export const ReviewResultSchema = z.discriminatedUnion("status", [
  ReviewNoReviewSchema,
  ReviewRevisionAppliedSchema,
]);

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ---- Milestone log -------------------------------------------------
//
// Two valid shapes:
//   {}                                 — discovery returned NONE/ALL_BLOCKED
//                                        OR the picked issue had no milestone
//   {milestone: string, log_issue: int|null}
//
// `log_issue` may be `null` when discovery picked an issue without a
// milestone (the bash port emitted that explicitly).

const MilestoneLogPresentSchema = z.object({
  milestone: z.string(),
  log_issue: z.number().int().positive().nullable(),
});

const MilestoneLogEmptySchema = z.object({}).strict();

export const MilestoneLogSchema = z.union([
  MilestoneLogPresentSchema,
  MilestoneLogEmptySchema,
]);

export type MilestoneLog = z.infer<typeof MilestoneLogSchema>;

// ---- parser helpers -----------------------------------------------

function parseWith<T>(
  schema: z.ZodType<T>,
  raw: string,
  what: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SchemaError(
      `${MODULE_PREFIX}: ${what} is not valid JSON: ${detail}`,
      undefined,
      err,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaError(
      `${MODULE_PREFIX}: ${what} failed schema validation: ${formatZodError(result.error)}`,
      undefined,
      result.error,
    );
  }
  return result.data;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length === 0 ? "<root>" : i.path.join(".");
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

export function parseDecision(raw: string): Decision {
  return parseWith(DecisionSchema, raw, "decision.json");
}

export function parseImplResult(raw: string): ImplResult {
  return parseWith(ImplResultSchema, raw, "impl-result.json");
}

export function parseReviewResult(raw: string): ReviewResult {
  return parseWith(ReviewResultSchema, raw, "review-result.json");
}

export function parseMilestoneLog(raw: string): MilestoneLog {
  return parseWith(MilestoneLogSchema, raw, "milestone-log.json");
}

// ---- readers --------------------------------------------------------
//
// readers wrap parsers with a file-read step. They re-throw SchemaError
// with the path attached so a CloudWatch grep tells the operator which
// contract file misbehaved.

function readContractFile<T>(
  path: string,
  parse: (raw: string) => T,
): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SchemaError(
      `${MODULE_PREFIX}: could not read ${path}: ${detail}`,
      path,
      err,
    );
  }
  try {
    return parse(raw);
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new SchemaError(`${err.message} (path: ${path})`, path, err.cause);
    }
    throw err;
  }
}

export function readDecision(path: string): Decision {
  return readContractFile(path, parseDecision);
}

export function readImplResult(path: string): ImplResult {
  return readContractFile(path, parseImplResult);
}

export function readReviewResult(path: string): ReviewResult {
  return readContractFile(path, parseReviewResult);
}

export function readMilestoneLog(path: string): MilestoneLog {
  return readContractFile(path, parseMilestoneLog);
}
