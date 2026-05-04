#!/usr/bin/env node
//
// ralph-orchestrate — slice 5 orchestrator (real). Replaces the iteration-1
// `lib/ec2-orchestrator.sh`. Runs the discovery → implementation → review
// state machine on a freshly bootstrapped EC2 worker.
//
// Usage:
//   ralph-orchestrate
//
// Reads the env contract documented in lib/ec2-orchestrator.ts. Exit codes
// are byte-compatible with iteration 1's `orch::run`.

import { run } from "../lib/ec2-orchestrator.js";

run()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ralph-orchestrate: ${msg}\n`);
    process.exit(1);
  });
