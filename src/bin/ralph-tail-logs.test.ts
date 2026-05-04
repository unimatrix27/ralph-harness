// CLI smoke tests for ralph-tail-logs. The bin is a thin wrapper around
// `aws logs tail`; we don't try to fake the AWS CLI here, just exercise the
// argument-routing logic via --help (which exits before spawning aws).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-tail-logs.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

describe("ralph-tail-logs", () => {
  it("--help exits 0 and prints usage", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/usage: ralph-tail-logs/);
    expect(r.stdout).toMatch(/RALPH_LOG_GROUP/);
  });
});
