// claude-runner — subprocess wrapper around `claude --print`.
//
// Exists so the orchestrator can be unit-tested by mocking exactly one module
// instead of stubbing the `claude` binary. The contract:
//
//   runClaude(prompt, opts) — spawn `claude --print [flags...]`, pipe the
//     prompt to stdin, forward stdout/stderr to the parent so CloudWatch
//     captures everything. Returns { exitCode } once the child exits.
//
// Knobs (read from opts; falls back to env or hard defaults):
//   bin           — process binary; default `claude` (override:
//                   RALPH_CLAUDE_BIN). Tests inject a stub.
//   flags         — extra CLI flags split on whitespace; default
//                   `--permission-mode bypassPermissions` (override:
//                   RALPH_CLAUDE_FLAGS). RALPH_DEBUG_TRANSCRIPT=1 swaps in the
//                   stream-json + --verbose set so the per-instance
//                   CloudWatch stream captures every assistant message and
//                   tool_use/tool_result.
//   model         — passed as `--model <value>` if set. Phase callers pull
//                   from RALPH_DISCOVERY_MODEL / RALPH_IMPL_MODEL /
//                   RALPH_REVIEW_MODEL.
//
// The wrapper does not interpret the prompt or claude's output — it is a
// thin pipe. Callers branch on exitCode and on the contract files claude
// writes under /tmp/ralph/.

import { spawn } from "node:child_process";

export const MODULE_PREFIX = "claude-runner";

const DEFAULT_FLAGS = "--permission-mode bypassPermissions";
const DEBUG_FLAGS =
  "--permission-mode bypassPermissions --output-format stream-json --verbose";

export interface RunClaudeOptions {
  bin?: string;
  flags?: string;       // raw flag string, whitespace-split into argv
  model?: string;       // optional --model <value>
  // Optional process.env passthrough — defaults to process.env.
  env?: NodeJS.ProcessEnv;
  // Optional stdout/stderr sinks. Default: forward to the parent's
  // process.stdout / process.stderr (the EC2 box → CloudWatch).
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface ClaudeResult {
  exitCode: number;
}

export class ClaudeRunnerError extends Error {
  constructor(public readonly cause: unknown, message: string) {
    super(message);
    this.name = "ClaudeRunnerError";
  }
}

// resolveFlags — picks the flag set per the env contract:
//   RALPH_DEBUG_TRANSCRIPT=1 → DEBUG_FLAGS (stream-json + --verbose)
//   RALPH_CLAUDE_FLAGS set    → use as-is
//   else                      → DEFAULT_FLAGS
export function resolveFlags(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RALPH_DEBUG_TRANSCRIPT === "1") return DEBUG_FLAGS;
  const explicit = env.RALPH_CLAUDE_FLAGS;
  if (explicit && explicit.length > 0) return explicit;
  return DEFAULT_FLAGS;
}

export function resolveBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.RALPH_CLAUDE_BIN && env.RALPH_CLAUDE_BIN.length > 0
    ? env.RALPH_CLAUDE_BIN
    : "claude";
}

export function buildArgv(
  flags: string,
  model?: string,
): string[] {
  const argv = ["--print", ...splitFlags(flags)];
  if (model && model.length > 0) {
    argv.push("--model", model);
  }
  return argv;
}

function splitFlags(s: string): string[] {
  // The bash port used `${RALPH_CLAUDE_FLAGS:-...}` array-splitting, which
  // splits on IFS. We replicate by splitting on runs of whitespace and
  // dropping empty fragments.
  return s
    .split(/[ \t\n]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export async function runClaude(
  prompt: string,
  opts: RunClaudeOptions = {},
): Promise<ClaudeResult> {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? resolveBin(env);
  const flags = opts.flags ?? resolveFlags(env);
  const argv = buildArgv(flags, opts.model);
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  return new Promise<ClaudeResult>((resolve, reject) => {
    let child;
    try {
      // The harness always runs claude inside a throwaway worker (cloud-init
      // EC2 or equivalent). Cloud-init runs as root; without IS_SANDBOX=1
      // claude refuses --permission-mode bypassPermissions / --dangerously-
      // skip-permissions and exits 1. Setting it here keeps the contract
      // self-contained — system-setup.sh's own export does not propagate
      // back to ralph-orchestrate's process env.
      child = spawn(bin, argv, {
        env: { IS_SANDBOX: "1", ...env } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new ClaudeRunnerError(
          err,
          `${MODULE_PREFIX}: failed to spawn ${bin}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }

    child.on("error", (err: Error) => {
      reject(
        new ClaudeRunnerError(
          err,
          `${MODULE_PREFIX}: ${bin} errored: ${err.message}`,
        ),
      );
    });

    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));

    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1 });
    });

    child.stdin?.end(prompt);
  });
}
