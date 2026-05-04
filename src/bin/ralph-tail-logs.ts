#!/usr/bin/env node
//
// ralph-tail-logs — tail the per-instance CloudWatch streams for one (or
// all) running ralph-harness EC2 worker(s). Net-new in slice 4 (iteration 1
// documented `aws logs tail …` as a one-liner).
//
// Usage:
//   ralph-tail-logs                       # tail every stream in /ralph/main
//   ralph-tail-logs <instance-id>         # tail just one stream (i-...)
//   ralph-tail-logs --since 30m           # forwarded to `aws logs tail`
//   ralph-tail-logs --no-follow ...       # forwarded to `aws logs tail`
//
// Implementation: this is a thin pass-through to `aws logs tail` (CLI v2).
// The CLI is the only AWS tool that ships a usable interactive tailer; the
// SDK's StartLiveTail API requires extra IAM perms most operators don't
// have. Forwarding keeps the operator UX identical.
//
// Reads from env:
//   RALPH_LOG_GROUP    log group to tail (default /ralph/main)
//
// Region is forced to eu-central-1 via the --region flag passed to aws.
//
// Exit codes:
//   0   aws exited 0
//   2   usage error
//   propagated   any non-zero exit from the underlying `aws` CLI

import { spawnSync } from "node:child_process";

import { AWS_REGION } from "../lib/aws-clients.js";

const MODULE_PREFIX = "ralph-tail-logs";
const DEFAULT_LOG_GROUP = "/ralph/main";

function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      `usage: ralph-tail-logs [<instance-id>] [extra args forwarded to 'aws logs tail']\n` +
        `\n` +
        `Tails the per-instance CloudWatch stream(s) for ralph-harness EC2 workers.\n` +
        `Without an instance id, tails every stream in the log group.\n` +
        `\n` +
        `env:\n` +
        `  RALPH_LOG_GROUP    log group to tail (default ${DEFAULT_LOG_GROUP})\n`,
    );
    process.exit(0);
  }

  const logGroup = process.env.RALPH_LOG_GROUP || DEFAULT_LOG_GROUP;

  // First positional argument that looks like an EC2 instance id is treated
  // as the stream filter; everything else is forwarded to `aws logs tail`.
  // (aws logs tail accepts `--log-stream-names <name>` for stream selection.)
  const passthrough: string[] = [];
  let instanceId: string | undefined;
  for (const a of argv) {
    if (!instanceId && /^i-[0-9a-f]+$/i.test(a)) {
      instanceId = a;
      continue;
    }
    passthrough.push(a);
  }

  const args = ["--region", AWS_REGION, "logs", "tail", logGroup, "--follow"];
  if (instanceId) {
    args.push("--log-stream-names", instanceId);
  }
  args.push(...passthrough);

  const r = spawnSync("aws", args, { stdio: "inherit" });
  if (r.error) {
    process.stderr.write(
      moduleErr(`failed to spawn aws: ${r.error.message}`) + "\n",
    );
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

main();
