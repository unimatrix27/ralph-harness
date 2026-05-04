// CLI smoke tests for ralph-bootstrap-aws. The heavy idempotency logic is
// unit-tested at the lib level (src/lib/aws-bootstrap.test.ts); this file
// just covers argv/env contract.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-bootstrap-aws.ts");

function runCli(env: Record<string, string | undefined> = {}) {
  const cleanedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete cleanedEnv[k];
    else cleanedEnv[k] = env[k];
  }
  return spawnSync(process.execPath, ["--import", "tsx", entry], {
    encoding: "utf8",
    env: cleanedEnv,
  });
}

describe("ralph-bootstrap-aws — drop-in for bin/bootstrap-aws.sh", () => {
  it("exits 2 when RALPH_TARGET_REPO is unset", () => {
    const r = runCli({ RALPH_TARGET_REPO: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/RALPH_TARGET_REPO is required/);
  });

  it("exits 2 when RALPH_TARGET_REPO is empty", () => {
    const r = runCli({ RALPH_TARGET_REPO: "" });
    expect(r.status).toBe(2);
  });
});
