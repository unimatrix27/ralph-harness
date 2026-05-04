// ralph-fire-wizard — interactive UX for `ralph-fire` when run from a TTY.
//
// Issue #36: when an operator runs `ralph-fire` from a clone of the
// target repo with no env vars set, walk them through the launch.
// Auto-discover RALPH_TARGET_REPO from `git remote get-url origin`,
// confirm with the operator, prompt for any other missing required
// fields, and validate the local `.ralph/config.yaml` schema version
// before handing off to the launcher.
//
// Design constraints:
//   - Non-TTY callers (CI, EC2 user-data, the fire-launcher subprocessing
//     `ralph-bootstrap-aws`) MUST NOT block on prompts. We do nothing
//     when stdin or stdout is not a TTY — the launcher's existing fail-
//     fast on missing env still fires downstream, byte-identical to the
//     pre-wizard behaviour.
//   - Operator-typed values always win over auto-discovered ones. If
//     `RALPH_TARGET_REPO` is already set in env, we never overwrite it.
//   - The wizard is purely additive — `ralph-fire` keeps working with
//     no TTY exactly as before.
//
// Public surface:
//   parseGithubRepoFromGitUrl(url) — pure, tested in isolation.
//   runWizard(opts)                — async; mutates the supplied env.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  CURRENT_SCHEMA_VERSION,
  validate as validateTargetConfig,
  ValidateError,
  readSchemaVersion,
} from "./target-config-schema.js";

export const MODULE_PREFIX = "ralph-fire-wizard";

// parseGithubRepoFromGitUrl — extract `owner/repo` from a git remote
// URL. Accepts the three forms `git remote get-url origin` can return:
//   https://github.com/owner/repo(.git)?
//   https://x-access-token:<pat>@github.com/owner/repo(.git)?
//   git@github.com:owner/repo(.git)?
// Returns null for anything else (gitlab, custom hosts, malformed input).
// The launcher only knows how to talk to github.com via the gh CLI, so
// we restrict to that host.
export function parseGithubRepoFromGitUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // SSH form
  const ssh = trimmed.match(
    /^[A-Za-z0-9._-]+@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
  );
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // HTTPS form (with or without auth prefix)
  const https = trimmed.match(
    /^https?:\/\/(?:[^/@]+@)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
  );
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

// gitRemoteOriginUrl — best-effort `git -C <cwd> remote get-url origin`.
// Returns null if cwd is not in a git repo, the remote doesn't exist,
// or git isn't installed. Never throws.
export function gitRemoteOriginUrl(cwd: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2_000 },
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface WizardIO {
  // Prompt the operator. Returns the entered string (already trimmed).
  ask: (question: string) => Promise<string>;
  // Print informational text (above prompts). Defaults to stdout.
  info: (line: string) => void;
}

export interface WizardOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  // Defaults to (process.stdin.isTTY === true && process.stdout.isTTY === true).
  isTty?: boolean;
  io?: WizardIO;
  // Test seam — defaults to gitRemoteOriginUrl.
  gitRemote?: (cwd: string) => string | null;
}

const DEFAULT_REGION = "eu-central-1";

function defaultIo(): WizardIO {
  // Lazy readline construction — only wired up when we actually need to
  // prompt, so unit tests that supply their own io stay free of fd leaks.
  let rl: ReturnType<typeof createInterface> | null = null;
  return {
    ask: async (q: string) => {
      if (rl === null) {
        rl = createInterface({ input: process.stdin, output: process.stdout });
      }
      const answer = await rl.question(q);
      return answer.trim();
    },
    info: (line: string) => process.stdout.write(`${line}\n`),
  };
}

// confirmYes — Y/n prompt that defaults to yes on empty input.
async function confirmYes(io: WizardIO, q: string): Promise<boolean> {
  const a = (await io.ask(`${q} [Y/n] `)).toLowerCase();
  if (a.length === 0) return true;
  return a === "y" || a === "yes";
}

// runWizard — interactive prompt path. No-op when not on a TTY. Mutates
// `opts.env` in place. Operator-typed env always wins; we never override
// a value the operator already set.
export async function runWizard(opts: WizardOptions): Promise<void> {
  const env = opts.env;
  const cwd = opts.cwd ?? process.cwd();
  const isTty =
    opts.isTty ??
    (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTty) return;

  const io = opts.io ?? defaultIo();
  const gitRemote = opts.gitRemote ?? gitRemoteOriginUrl;

  await populateTargetRepo(env, cwd, io, gitRemote);
  await populateAwsRegion(env, io);
  await maybeValidateLocalConfig(cwd, io);
}

async function populateTargetRepo(
  env: NodeJS.ProcessEnv,
  cwd: string,
  io: WizardIO,
  gitRemote: (cwd: string) => string | null,
): Promise<void> {
  if (env.RALPH_TARGET_REPO && env.RALPH_TARGET_REPO.length > 0) return;

  const remote = gitRemote(cwd);
  const discovered = remote ? parseGithubRepoFromGitUrl(remote) : null;

  if (discovered) {
    if (await confirmYes(io, `Use ${discovered} as RALPH_TARGET_REPO?`)) {
      env.RALPH_TARGET_REPO = discovered;
      return;
    }
  }

  const fallbackHint = discovered ?? "owner/repo";
  for (;;) {
    const typed = await io.ask(`RALPH_TARGET_REPO (${fallbackHint}): `);
    if (typed.length > 0 && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(typed)) {
      env.RALPH_TARGET_REPO = typed;
      return;
    }
    io.info(
      `${MODULE_PREFIX}: expected the form owner/repo (got ${JSON.stringify(typed)})`,
    );
  }
}

async function populateAwsRegion(
  env: NodeJS.ProcessEnv,
  io: WizardIO,
): Promise<void> {
  if (env.RALPH_AWS_REGION && env.RALPH_AWS_REGION.length > 0) return;
  const typed = await io.ask(`RALPH_AWS_REGION (${DEFAULT_REGION}): `);
  env.RALPH_AWS_REGION = typed.length > 0 ? typed : DEFAULT_REGION;
}

// maybeValidateLocalConfig — when the operator is standing in a clone
// that already has a `.ralph/config.yaml`, surface schema-version
// mismatches up-front rather than waiting for system-setup.sh to fail
// on the EC2 worker. We do NOT block the launch — the authoritative
// validator runs on the worker against the target's tip-of-default-
// branch, which may differ from the operator's clone — but we warn so
// the operator can decide whether to fix it locally first.
async function maybeValidateLocalConfig(
  cwd: string,
  io: WizardIO,
): Promise<void> {
  const cfgPath = resolvePath(cwd, ".ralph", "config.yaml");
  if (!existsSync(cfgPath)) return;
  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf8");
  } catch {
    return;
  }

  const localVersion = readSchemaVersion(raw);
  if (localVersion === undefined) {
    io.info(
      `${MODULE_PREFIX}: ${cfgPath} has no schema_version; harness expects ${CURRENT_SCHEMA_VERSION}. Add 'schema_version: ${CURRENT_SCHEMA_VERSION}' to silence this warning.`,
    );
  } else if (localVersion !== CURRENT_SCHEMA_VERSION) {
    io.info(
      `${MODULE_PREFIX}: ${cfgPath} declares schema_version=${localVersion}; harness expects ${CURRENT_SCHEMA_VERSION}. The on-EC2 validator will reject this — update the file before launching.`,
    );
    return;
  }

  try {
    validateTargetConfig(raw);
  } catch (err) {
    if (err instanceof ValidateError) {
      io.info(
        `${MODULE_PREFIX}: ${cfgPath} failed local schema validation (code ${err.code}): ${err.message}`,
      );
    }
  }
}
