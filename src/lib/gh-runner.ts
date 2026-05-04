// gh-runner — thin subprocess wrapper around the `gh` CLI.
//
// Exists so github-state-mutator (and any future caller) can be unit-tested
// by mocking exactly one module instead of stubbing a binary on PATH.
//
// Contract:
//   runGh(args)  — spawn `gh <args...>`, return { stdout, stderr, exitCode }.
//   runGhJson(args) — same, but JSON.parse the stdout (caller still passes
//                     `--json` to gh; this just parses the result).
//
// Both functions throw GhRunnerError on non-zero exit. Callers that need to
// branch on a non-zero exit (none today) can catch and inspect .exitCode.

import { spawnSync } from "node:child_process";

const MODULE_PREFIX = "gh-runner";

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GhRunnerError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "GhRunnerError";
  }
}

export function runGh(args: readonly string[]): GhResult {
  const r = spawnSync("gh", args, { encoding: "utf8" });

  if (r.error) {
    throw new GhRunnerError(
      -1,
      "",
      `${MODULE_PREFIX}: failed to spawn gh: ${r.error.message}`,
    );
  }

  const result: GhResult = {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };

  if (result.exitCode !== 0) {
    throw new GhRunnerError(
      result.exitCode,
      result.stderr,
      `${MODULE_PREFIX}: gh ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  return result;
}

export function runGhJson<T = unknown>(args: readonly string[]): T {
  const { stdout } = runGh(args);
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GhRunnerError(
      0,
      "",
      `${MODULE_PREFIX}: could not parse gh stdout as JSON: ${detail}`,
    );
  }
}
