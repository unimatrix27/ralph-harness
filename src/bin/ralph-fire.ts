#!/usr/bin/env node
//
// ralph-fire — slice 5 launcher (real). Replaces iteration-1's
// `bin/fire.sh` + `lib/fire-launcher.sh`. Loads `.env` from CWD then XDG,
// optionally subprocesses `ralph-bootstrap-aws` for first-run idempotent
// AWS-side resource ensure, then calls the launcher.
//
// Usage:
//   ralph-fire             — fire one EC2 worker
//   ralph-fire --version   — print the package version and exit
//
// Env knobs: see lib/fire-launcher.ts (resolveLauncherConfig). The set is
// byte-compatible with iteration-1's lib/fire-launcher.sh.
//
// Auto-bootstrap: defaults to subprocessing `ralph-bootstrap-aws` once
// before launching. Set RALPH_SKIP_BOOTSTRAP=1 to suppress.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { loadDotenv } from "../lib/env-loader.js";
import { LauncherError, run } from "../lib/fire-launcher.js";
import { runWizard } from "../lib/ralph-fire-wizard.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }
  if (args.length > 0) {
    process.stderr.write(
      `ralph-fire: unexpected arguments: ${args.join(" ")}\n`,
    );
    process.exit(2);
  }

  loadDotenv();

  // Issue #36: when invoked from a TTY with required env unset, walk the
  // operator through to a launch (auto-discover RALPH_TARGET_REPO from
  // `git remote get-url origin`, prompt for missing fields, validate the
  // local .ralph/config.yaml schema version). No-op on non-TTY callers
  // (CI, EC2 user-data) — the launcher's existing fail-fast still fires.
  await runWizard({ env: process.env });

  if (process.env.RALPH_SKIP_BOOTSTRAP !== "1") {
    const r = spawnSync("ralph-bootstrap-aws", [], {
      stdio: "inherit",
      env: process.env,
    });
    if (r.error) {
      process.stderr.write(
        `ralph-fire: ralph-bootstrap-aws not found on PATH; install the package globally (npm install -g @unimatrix27/ralph-harness) or set RALPH_SKIP_BOOTSTRAP=1\n`,
      );
      process.exit(2);
    }
    if ((r.status ?? 1) !== 0) {
      process.exit(r.status ?? 1);
    }
  }

  const rc = await run({ defaultHarnessVersion: pkg.version });
  process.exit(rc);
}

main().catch((err) => {
  if (err instanceof LauncherError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ralph-fire: ${msg}\n`);
  process.exit(1);
});
