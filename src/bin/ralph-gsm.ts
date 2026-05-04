#!/usr/bin/env node
//
// ralph-gsm — CLI wrapper around src/lib/github-state-mutator. Drop-in
// replacement for the (deleted) bin/gsm bash script.
//
// Usage:
//   ralph-gsm swap-label <repo> <issue#> <from-label> <to-label>
//   ralph-gsm comment-issue <repo> <issue#> <body>
//   ralph-gsm find-or-create-log <repo> <milestone>
//   ralph-gsm append-caveman-log <repo> <log#> <issue#> <summary> [<gotcha>]
//
// Exit codes (matching bin/gsm):
//   0  success
//   2  usage / missing required argument
//   non-zero  propagated from gh via GhRunnerError

import {
  GhRunnerError,
  appendCavemanLog,
  commentIssue,
  findOrCreateMilestoneLogIssue,
  moduleErr,
  swapLabel,
} from "../lib/github-state-mutator.js";

const USAGE = `usage: ralph-gsm <command> [args]

commands:
  swap-label <repo> <issue#> <from-label> <to-label>
  comment-issue <repo> <issue#> <body>
  find-or-create-log <repo> <milestone>
  append-caveman-log <repo> <log#> <issue#> <summary> [<gotcha>]
`;

function fail(message: string, code: number): never {
  process.stderr.write(moduleErr(message) + "\n");
  process.exit(code);
}

function usage(code: number): never {
  process.stderr.write(USAGE);
  process.exit(code);
}

function parseIssueNum(raw: string, label: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
    fail(`${label} must be a positive integer, got '${raw}'`, 2);
  }
  return n;
}

function requireArgs(cmd: string, want: number, got: number): void {
  if (got < want) fail(`${cmd}: expected ${want} args, got ${got}`, 2);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) usage(2);
if (cmd === "-h" || cmd === "--help" || cmd === "help") usage(0);

const rest = args.slice(1);

try {
  switch (cmd) {
    case "swap-label": {
      requireArgs("swap-label", 4, rest.length);
      const [repo, numRaw, from, to] = rest as [string, string, string, string];
      swapLabel(repo, parseIssueNum(numRaw, "issue#"), from, to);
      break;
    }
    case "comment-issue": {
      requireArgs("comment-issue", 3, rest.length);
      const [repo, numRaw, body] = rest as [string, string, string];
      commentIssue(repo, parseIssueNum(numRaw, "issue#"), body);
      break;
    }
    case "find-or-create-log": {
      requireArgs("find-or-create-log", 2, rest.length);
      const [repo, milestone] = rest as [string, string];
      const n = findOrCreateMilestoneLogIssue(repo, milestone);
      process.stdout.write(`${n}\n`);
      break;
    }
    case "append-caveman-log": {
      requireArgs("append-caveman-log", 4, rest.length);
      const [repo, logRaw, issueRaw, summary, gotcha] = rest as [
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      appendCavemanLog(
        repo,
        parseIssueNum(logRaw, "log#"),
        parseIssueNum(issueRaw, "issue#"),
        summary,
        gotcha,
      );
      break;
    }
    default:
      process.stderr.write(`ralph-gsm: unknown command: ${cmd}\n`);
      usage(2);
  }
} catch (err) {
  if (err instanceof GhRunnerError) {
    process.stderr.write(moduleErr(err.message) + "\n");
    process.exit(err.exitCode === 0 ? 1 : err.exitCode);
  }
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(detail + "\n");
  process.exit(1);
}

process.exit(0);
