// ec2-orchestrator — TS port of iteration-1's lib/ec2-orchestrator.sh.
//
// Entry point for the discovery → implementation → review state machine
// running on a freshly bootstrapped EC2 worker. Phase markers,
// CloudWatch-bound stdout/stderr, and the contract files under /tmp/ralph
// are all preserved byte-identical to iteration 1.
//
// Public surface:
//   run(opts) — full state machine. Returns an exit code (0/1/2/3) that
//               the bin entry passes to process.exit.
//   resolveOrchestratorConfig(env) — pure resolver, exposed for tests.
//
// Reads from env (set by the cloud-init bootstrap):
//   RALPH_TARGET_REPO        owner/repo (required)
//   RALPH_AWS_REGION         informational
//   RALPH_WORK_DIR           absolute path to the fresh clone
//   RALPH_DEFAULT_BRANCH     resolved default branch of the target repo
//   RALPH_CONFIG             path to the validated .ralph/config.yaml
//   RALPH_LAUNCH_TAG         per-launch identifier embedded in PR bodies
//
// With overridable defaults:
//   RALPH_OUT_DIR                 /tmp/ralph
//   RALPH_DISCOVERY_PROMPT        <package>/prompts/discovery.md
//   RALPH_IMPLEMENTATION_PROMPT   <package>/prompts/implementation.md
//   RALPH_REVIEW_PROMPT           <package>/prompts/review.md
//   RALPH_REVIEW_WAIT_SEC         600
//
// Exit codes:
//   0   discovery completed (NONE/ALL_BLOCKED) OR full chain completed
//   1   claude invocation failed
//   2   missing required env (target repo)
//   3   contract violation (missing/invalid output, unknown status)

import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaude, type RunClaudeOptions } from "./claude-runner.js";
import {
  parseDecision,
  parseImplResult,
  parseReviewResult,
  type Decision,
  type ImplResult,
  type ReviewResult,
} from "./phase-result-schemas.js";
import { render, type PromptContext } from "./prompt-renderer.js";
import {
  Emitter,
  outcome as outcomeMarker,
  pickedIssue as pickedIssueMarker,
  realClock,
  stdoutSink,
  type Phase,
  type Sink,
} from "./structured-log-emitter.js";
import {
  validate as validateTargetConfig,
  type TargetConfig,
} from "./target-config-schema.js";

export const MODULE_PREFIX = "ec2-orchestrator";

export class OrchestratorError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

const DEFAULT_REVIEW_WAIT_SEC = 600;
const DEFAULT_OUT_DIR = "/tmp/ralph";

export interface OrchestratorConfig {
  targetRepo: string;
  awsRegion: string;
  workDir: string;
  defaultBranch: string;
  configPath: string;
  launchTag: string;
  outDir: string;
  discoveryPromptPath: string;
  implementationPromptPath: string;
  reviewPromptPath: string;
  reviewWaitSec: number;
}

export function resolveOrchestratorConfig(
  env: NodeJS.ProcessEnv,
  packageRoot: string,
): OrchestratorConfig {
  const targetRepo = env.RALPH_TARGET_REPO ?? "";
  if (targetRepo.length === 0) {
    throw new OrchestratorError(
      2,
      `${MODULE_PREFIX}: error: RALPH_TARGET_REPO is required`,
    );
  }
  const promptsRoot = resolvePath(packageRoot, "prompts");
  return {
    targetRepo,
    awsRegion: env.RALPH_AWS_REGION ?? "",
    workDir: env.RALPH_WORK_DIR ?? "",
    defaultBranch: env.RALPH_DEFAULT_BRANCH ?? "",
    configPath: env.RALPH_CONFIG ?? "",
    launchTag: env.RALPH_LAUNCH_TAG ?? "",
    outDir: env.RALPH_OUT_DIR ?? DEFAULT_OUT_DIR,
    discoveryPromptPath:
      env.RALPH_DISCOVERY_PROMPT ?? resolvePath(promptsRoot, "discovery.md"),
    implementationPromptPath:
      env.RALPH_IMPLEMENTATION_PROMPT ??
      resolvePath(promptsRoot, "implementation.md"),
    reviewPromptPath:
      env.RALPH_REVIEW_PROMPT ?? resolvePath(promptsRoot, "review.md"),
    reviewWaitSec: parseReviewWait(env.RALPH_REVIEW_WAIT_SEC),
  };
}

function parseReviewWait(raw: string | undefined): number {
  if (!raw || raw.length === 0) return DEFAULT_REVIEW_WAIT_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REVIEW_WAIT_SEC;
  return n;
}

// loadTargetConfig — best-effort YAML read. Returns undefined when the
// path is empty or the file is missing — the orchestrator emits empty
// strings for the unresolved {{...}} keys in that case (matching the
// bash port's `yq … // ""` fallback).
async function loadTargetConfig(
  configPath: string,
): Promise<TargetConfig | undefined> {
  if (configPath.length === 0) return undefined;
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return validateTargetConfig(raw);
  } catch {
    // We do not block the orchestrator on a malformed config — the
    // operator's `ralph-validate-config` CLI is the authoritative gate.
    // Empty values just leave the prompts with literal `{{KEY}}`
    // placeholders, which is greppable in CloudWatch.
    return undefined;
  }
}

type ClaudeRunner = (
  prompt: string,
  opts?: RunClaudeOptions,
) => Promise<{ exitCode: number }>;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  // The directory that contains `prompts/`. Defaults to the package root
  // resolved via import.meta.url.
  packageRoot?: string;
  // Hooks for tests.
  claude?: ClaudeRunner;
  sleep?: Sleep;
  sink?: Sink;
  clock?: () => Date;
  // Optional override for the system-setup invocation. Tests pass a no-op.
  runSystemSetup?: (workDir: string) => Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

// runSystemSetupDefault — invoke the OS-level cloud-init script that ships
// inside the npm package at lib/cloud-init/system-setup.sh. Best-effort:
// if the file is missing (running outside the published package, e.g. a
// dev `tsx` invocation against the source tree), we no-op. The post-
// condition the orchestrator depends on is "claude CLI + gh + repo clone
// + .ralph/config.yaml validated" — operators who run from source are
// expected to have set those up themselves.
async function runSystemSetupDefault(workDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const candidates = [
    // dist build → lib/cloud-init/system-setup.sh next to dist
    resolvePath(here, "..", "..", "lib", "cloud-init", "system-setup.sh"),
    // src tree
    resolvePath(here, "..", "..", "..", "lib", "cloud-init", "system-setup.sh"),
  ];
  for (const path of candidates) {
    try {
      const { existsSync } = await import("node:fs");
      if (!existsSync(path)) continue;
      const child = spawn("bash", [path], {
        stdio: "inherit",
        cwd: workDir.length > 0 ? workDir : process.cwd(),
        env: process.env,
      });
      const rc: number = await new Promise((res) => {
        child.on("close", (code) => res(code ?? -1));
        child.on("error", () => res(-1));
      });
      if (rc !== 0) {
        throw new OrchestratorError(
          rc,
          `${MODULE_PREFIX}: system-setup.sh exited ${rc}`,
        );
      }
      return;
    } catch (err) {
      if (err instanceof OrchestratorError) throw err;
      // continue to the next candidate
    }
  }
  // No system-setup.sh present — skip silently.
}

interface PromptContextBundle {
  config: OrchestratorConfig;
  target?: TargetConfig;
}

function buildDiscoveryContext(b: PromptContextBundle): PromptContext {
  return {
    RALPH_TARGET_REPO: b.config.targetRepo,
    RALPH_DEFAULT_BRANCH: b.config.defaultBranch,
    RALPH_WORK_DIR: b.config.workDir,
    RALPH_BUILD_CMD: b.target?.build_cmd ?? "",
    RALPH_TEST_CMD: b.target?.test_cmd ?? "",
    RALPH_BRANCH_PREFIX: b.target?.branch_prefix ?? "",
    PROMPT_EXTENSION: b.target?.prompt_extensions?.discovery ?? "",
  };
}

function buildImplContext(b: PromptContextBundle): PromptContext {
  return {
    RALPH_TARGET_REPO: b.config.targetRepo,
    RALPH_DEFAULT_BRANCH: b.config.defaultBranch,
    RALPH_WORK_DIR: b.config.workDir,
    RALPH_BUILD_CMD: b.target?.build_cmd ?? "",
    RALPH_TEST_CMD: b.target?.test_cmd ?? "",
    RALPH_BRANCH_PREFIX: b.target?.branch_prefix ?? "",
    RALPH_AGENT_STUCK_LABEL: b.target?.agent_stuck_label ?? "agent-stuck",
    RALPH_LAUNCH_TAG: b.config.launchTag,
    PROMPT_EXTENSION: b.target?.prompt_extensions?.implementation ?? "",
  };
}

function buildReviewContext(
  b: PromptContextBundle,
  issue: number,
  pr: number,
  prBranch: string,
): PromptContext {
  return {
    RALPH_TARGET_REPO: b.config.targetRepo,
    RALPH_DEFAULT_BRANCH: b.config.defaultBranch,
    RALPH_WORK_DIR: b.config.workDir,
    RALPH_BUILD_CMD: b.target?.build_cmd ?? "",
    RALPH_TEST_CMD: b.target?.test_cmd ?? "",
    RALPH_ISSUE_NUMBER: String(issue),
    RALPH_PR_NUMBER: String(pr),
    RALPH_PR_BRANCH: prBranch,
    RALPH_REVIEW_BOT_USERNAME: b.target?.review_bot.username ?? "",
    RALPH_REVIEW_BOT_SOURCE: b.target?.review_bot.source ?? "",
    PROMPT_EXTENSION: b.target?.prompt_extensions?.review ?? "",
  };
}

function readContractText(path: string): string {
  return readFileSync(path, "utf8");
}

// mergeSetupEnvFile — reads a `KEY=VALUE` env file written by
// system-setup.sh and merges it into the supplied env object. Missing
// file is a no-op. Each line is trimmed; lines without `=` are skipped.
// Values can be unquoted or wrapped in double quotes.
export function mergeSetupEnvFile(
  path: string,
  env: NodeJS.ProcessEnv,
): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    count += 1;
  }
  return count;
}

function readDecisionFile(outDir: string): Decision {
  return parseDecision(readContractText(resolvePath(outDir, "decision.json")));
}

function verifyDiscoveryOutputs(outDir: string): void {
  for (const f of [
    "decision.json",
    "issue.json",
    "crafted-prompt.md",
    "milestone-log.json",
  ]) {
    try {
      readContractText(resolvePath(outDir, f));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new OrchestratorError(
        3,
        `${MODULE_PREFIX}: discovery did not write ${outDir}/${f}: ${detail}`,
      );
    }
  }
  // decision.json must parse — done via readDecisionFile when consumed.
}

function readImplFile(outDir: string): ImplResult {
  try {
    return parseImplResult(
      readContractText(resolvePath(outDir, "impl-result.json")),
    );
  } catch (err) {
    if (err instanceof Error) {
      throw new OrchestratorError(
        3,
        `${MODULE_PREFIX}: ${err.message}`,
      );
    }
    throw err;
  }
}

function readReviewFile(outDir: string): ReviewResult {
  try {
    return parseReviewResult(
      readContractText(resolvePath(outDir, "review-result.json")),
    );
  } catch (err) {
    if (err instanceof Error) {
      throw new OrchestratorError(
        3,
        `${MODULE_PREFIX}: ${err.message}`,
      );
    }
    throw err;
  }
}

interface PhaseResult {
  exitCode: number;
  durationSec: number;
}

async function runClaudePhase(
  rendered: string,
  claude: ClaudeRunner,
  startedAtMs: number,
): Promise<PhaseResult> {
  const r = await claude(rendered);
  const elapsedSec = Math.floor((Date.now() - startedAtMs) / 1000);
  return { exitCode: r.exitCode, durationSec: elapsedSec };
}

// run — full discovery → implementation → review state machine. Returns
// the exit code that `ralph-orchestrate` should pass to process.exit.
export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const sink = opts.sink ?? stdoutSink;
  const clock = opts.clock ?? realClock;
  const claude = opts.claude ?? runClaude;
  const sleep = opts.sleep ?? realSleep;
  const packageRoot = opts.packageRoot ?? resolvePath(here, "..", "..");

  let config: OrchestratorConfig;
  try {
    config = resolveOrchestratorConfig(env, packageRoot);
  } catch (err) {
    if (err instanceof OrchestratorError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }

  const info = (line: string) => sink(`${MODULE_PREFIX}: ${line}`);
  info("ralph-harness orchestrator");
  info(
    `target=${config.targetRepo} work_dir=${config.workDir} default_branch=${config.defaultBranch} config=${config.configPath} out=${config.outDir} launch_tag=${config.launchTag}`,
  );

  await mkdir(config.outDir, { recursive: true });

  const runSystemSetup = opts.runSystemSetup ?? runSystemSetupDefault;
  await runSystemSetup(config.workDir);

  // system-setup.sh writes RALPH_WORK_DIR / RALPH_DEFAULT_BRANCH /
  // RALPH_CONFIG / RALPH_LAUNCH_TAG into /tmp/ralph/setup.env (one
  // KEY=VALUE per line). Merge those values into env so the rest of the
  // orchestrator sees them. We re-resolve the config afterwards.
  mergeSetupEnvFile(resolvePath(config.outDir, "setup.env"), env);
  config = resolveOrchestratorConfig(env, packageRoot);

  const target = await loadTargetConfig(config.configPath);
  const bundle: PromptContextBundle = { config, target };
  const emitter = new Emitter(sink, clock);

  // ---- Discovery ----
  const discoveryTemplate = await readFile(
    config.discoveryPromptPath,
    "utf8",
  );
  const discoveryRendered = render(
    discoveryTemplate,
    buildDiscoveryContext(bundle),
  );

  emitter.start({ phase: "discovery", target: config.targetRepo });
  const discoveryStart = Date.now();
  const discoveryResult = await runClaudePhase(
    discoveryRendered,
    claude,
    discoveryStart,
  );
  emitter.end({
    phase: "discovery",
    durationSec: discoveryResult.durationSec,
  });

  if (discoveryResult.exitCode !== 0) {
    process.stderr.write(
      `${MODULE_PREFIX}: error: claude discovery exited ${discoveryResult.exitCode}\n`,
    );
    return 1;
  }

  try {
    verifyDiscoveryOutputs(config.outDir);
  } catch (err) {
    if (err instanceof OrchestratorError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }

  let decision: Decision;
  try {
    decision = readDecisionFile(config.outDir);
  } catch (err) {
    process.stderr.write(
      `${MODULE_PREFIX}: error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 3;
  }

  if (decision.status === "NONE") {
    info("discovery returned NONE — no eligible candidates");
    sink(outcomeMarker({ kind: "no_work" }));
    return 0;
  }
  if (decision.status === "ALL_BLOCKED") {
    info(
      "discovery returned ALL_BLOCKED — every candidate has unsatisfied blockers",
    );
    sink(outcomeMarker({ kind: "all_blocked" }));
    return 0;
  }

  // PICKED branch
  const issue = decision.issue;
  info(`discovery picked issue #${issue}`);
  sink(pickedIssueMarker(issue));

  // ---- Implementation ----
  const implTemplate = await readFile(
    config.implementationPromptPath,
    "utf8",
  );
  const craftedPath = resolvePath(config.outDir, "crafted-prompt.md");
  let crafted: string;
  try {
    crafted = await readFile(craftedPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${MODULE_PREFIX}: error: crafted-prompt.md not found: ${detail}\n`,
    );
    return 3;
  }
  const implRendered = `${render(implTemplate, buildImplContext(bundle))}\n\n---\n\n## Crafted context from discovery\n\n${crafted}`;

  emitter.start({ phase: "implementation", issue });
  const implStart = Date.now();
  const implResult = await runClaudePhase(implRendered, claude, implStart);
  let impl: ImplResult | undefined;
  try {
    impl = readImplFile(config.outDir);
  } catch (err) {
    if (err instanceof OrchestratorError) {
      // We still want to emit the PHASE_END marker before bailing, with
      // status=unknown.
      emitter.end({
        phase: "implementation",
        durationSec: implResult.durationSec,
        issue,
        status: "unknown",
      });
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
  emitter.end({
    phase: "implementation",
    durationSec: implResult.durationSec,
    issue,
    status: impl.status,
  });

  if (implResult.exitCode !== 0) {
    process.stderr.write(
      `${MODULE_PREFIX}: error: claude implementation exited ${implResult.exitCode}\n`,
    );
    return 1;
  }

  if (impl.status === "AGENT_STUCK") {
    info(`implementation reported agent_stuck for issue #${issue}`);
    sink(outcomeMarker({ kind: "agent_stuck", issue }));
    return 0;
  }

  // PR_OPENED branch
  const prNumber = impl.pr_number;
  const prBranch = impl.branch;
  info(`implementation opened PR #${prNumber} for issue #${issue}`);

  // ---- Review ----
  if (config.reviewWaitSec > 0) {
    info(`review: sleeping ${config.reviewWaitSec}s for review bot window`);
    await sleep(config.reviewWaitSec * 1_000);
  }

  const reviewTemplate = await readFile(config.reviewPromptPath, "utf8");
  const reviewRendered = render(
    reviewTemplate,
    buildReviewContext(bundle, issue, prNumber, prBranch),
  );

  emitter.start({ phase: "review", issue, pr: prNumber });
  const reviewStart = Date.now();
  const reviewResult = await runClaudePhase(
    reviewRendered,
    claude,
    reviewStart,
  );
  let review: ReviewResult | undefined;
  try {
    review = readReviewFile(config.outDir);
  } catch (err) {
    if (err instanceof OrchestratorError) {
      emitter.end({
        phase: "review",
        durationSec: reviewResult.durationSec,
        issue,
        pr: prNumber,
        status: "unknown",
      });
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
  emitter.end({
    phase: "review",
    durationSec: reviewResult.durationSec,
    issue,
    pr: prNumber,
    status: review.status,
  });

  if (reviewResult.exitCode !== 0) {
    process.stderr.write(
      `${MODULE_PREFIX}: error: claude review exited ${reviewResult.exitCode}\n`,
    );
    return 1;
  }

  if (review.status === "NO_REVIEW") {
    info(
      "review: no verdict from configured review bot; no caveman log appended",
    );
    sink(
      outcomeMarker({
        kind: "pr_opened",
        issue,
        pr: prNumber,
        review: "none",
      }),
    );
    return 0;
  }

  // REVISION_APPLIED → caveman log append handled by the review call's
  // own exit (slice 9 contract). The orchestrator just records the OUTCOME.
  info(`review: revision applied to PR #${prNumber}`);
  sink(
    outcomeMarker({
      kind: "pr_opened",
      issue,
      pr: prNumber,
      review: "revised",
    }),
  );
  return 0;
}

// Suppress unused-export warnings for type-only re-exports consumers may need.
export type { Phase };
