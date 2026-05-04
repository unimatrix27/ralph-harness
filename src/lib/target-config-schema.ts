// target-config-schema — load + validate a target repo's .ralph/config.yaml.
//
// Pure module: YAML string in / typed config out, or throws ValidateError
// with a numbered exit code that the CLI surfaces as its own exit code.
//
// Exit codes (must match lib/target-config-schema.sh — bash module is still
// sourced by the EC2 orchestrator until slice 5 cuts it over):
//   0  valid                                    (no error thrown)
//   2  usage / file not found                   (CLI only — see ralph-validate-config)
//   3  malformed yaml
//   4  missing required field
//   5  unknown field
//   6  type error or invalid value
//   7  reserved (was: missing yq dependency in the bash port; not used here)
//
// Schema: see docs/config-schema.md.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const MODULE_PREFIX = "target-config-schema";

export type ValidateExitCode = 3 | 4 | 5 | 6;

export class ValidateError extends Error {
  constructor(
    public readonly code: ValidateExitCode,
    message: string,
  ) {
    super(message);
    this.name = "ValidateError";
  }
}

const NonEmptyString = z.string().min(1);

const ReviewBotSchema = z
  .object({
    username: NonEmptyString,
    source: z.enum(["comment", "review"]),
  })
  .strict();

const PromptExtensionsSchema = z
  .object({
    discovery: NonEmptyString.optional(),
    implementation: NonEmptyString.optional(),
    review: NonEmptyString.optional(),
  })
  .strict();

const BranchPrefixSchema = NonEmptyString.refine(
  (v) => !v.includes("/") && !/\s/.test(v),
  { message: "branch_prefix must not contain '/' or whitespace" },
);

export const TargetConfigSchema = z
  .object({
    build_cmd: NonEmptyString,
    test_cmd: NonEmptyString,
    branch_prefix: BranchPrefixSchema,
    review_bot: ReviewBotSchema,
    agent_stuck_label: NonEmptyString.optional(),
    prompt_extensions: PromptExtensionsSchema.optional(),
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export function validate(yamlString: string): TargetConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlString, { prettyErrors: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ValidateError(3, `malformed yaml: ${detail}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new ValidateError(6, "top-level must be a mapping, got empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? "array" : typeof parsed;
    throw new ValidateError(6, `top-level must be a mapping, got ${got}`);
  }

  const result = TargetConfigSchema.safeParse(parsed);
  if (result.success) return result.data;

  throw issueToValidateError(result.error, parsed);
}

function issueToValidateError(
  err: z.ZodError,
  input: unknown,
): ValidateError {
  // Prefer issues that map to the most specific exit code so a multi-issue
  // failure surfaces the same code the bash module would have surfaced
  // (which checks unknown-field rejection BEFORE per-field type checks, and
  // missing-field BEFORE wrong-type).
  const ranked = [...err.issues].sort(
    (a, b) => issueRank(a, input) - issueRank(b, input),
  );
  const issue = ranked[0]!;
  const path = issue.path.map(String);
  const pathStr = path.length > 0 ? path.join(".") : "<root>";

  if (issue.code === "unrecognized_keys") {
    const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
    const key = keys[0] ?? "<unknown>";
    const fullKey = path.length > 0 ? `${pathStr}.${key}` : key;
    return new ValidateError(5, `unknown field: ${fullKey}`);
  }

  if (issue.code === "invalid_type") {
    const expected =
      (issue as unknown as { expected?: string }).expected ?? "valid value";
    if (!pathExists(input, issue.path)) {
      return new ValidateError(4, `missing required field: ${pathStr}`);
    }
    const got = actualTypeAt(input, issue.path);
    return new ValidateError(
      6,
      `${pathStr} must be a ${expected}, got ${got}`,
    );
  }

  if (issue.code === "too_small" || issue.code === "too_big") {
    return new ValidateError(6, `${pathStr} must be a non-empty string`);
  }

  // Zod 4 names enum mismatches "invalid_value"; Zod 3 used "invalid_enum_value".
  if (
    (issue.code as string) === "invalid_value" ||
    (issue.code as string) === "invalid_enum_value"
  ) {
    const opts =
      (issue as unknown as { options?: readonly unknown[] }).options ??
      (issue as unknown as { values?: readonly unknown[] }).values ??
      [];
    const optList = opts.map((o) => `'${String(o)}'`).join(" or ");
    const received = (issue as unknown as { received?: unknown }).received;
    return new ValidateError(
      6,
      `${pathStr} must be ${optList || "a valid value"}, got '${formatReceived(received)}'`,
    );
  }

  if (issue.code === "custom") {
    return new ValidateError(6, `${pathStr}: ${issue.message}`);
  }

  return new ValidateError(6, `${pathStr}: ${issue.message}`);
}

function issueRank(issue: z.ZodIssue, input: unknown): number {
  // Lower wins. Order: unknown field (5) → missing field (4) → everything else (6).
  if (issue.code === "unrecognized_keys") return 0;
  if (issue.code === "invalid_type" && !pathExists(input, issue.path)) return 1;
  return 2;
}

function pathExists(input: unknown, path: readonly PropertyKey[]): boolean {
  let cur: unknown = input;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return false;
    cur = (cur as Record<string, unknown>)[String(p)];
  }
  return true;
}

function actualTypeAt(input: unknown, path: readonly PropertyKey[]): string {
  let cur: unknown = input;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return "undefined";
    cur = (cur as Record<string, unknown>)[String(p)];
  }
  if (Array.isArray(cur)) return "array";
  if (cur === null) return "null";
  return typeof cur;
}

function formatReceived(received: unknown): string {
  if (received === undefined) return "undefined";
  if (typeof received === "string") return received;
  return String(received);
}

export function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}
