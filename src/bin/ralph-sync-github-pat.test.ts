// CLI smoke tests for ralph-sync-github-pat. Net-new in slice 4.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-sync-github-pat.ts");

interface RunOpts {
  args?: string[];
  stdin?: string;
}

function runCli(opts: RunOpts = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", entry, ...(opts.args ?? [])],
    {
      encoding: "utf8",
      input: opts.stdin,
      env: process.env,
    },
  );
}

describe("ralph-sync-github-pat", () => {
  it("rejects argv (token must come from stdin)", () => {
    const r = runCli({ args: ["my-token"] });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no arguments/);
  });

  it("exits 2 when stdin is empty", () => {
    const r = runCli({ stdin: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/empty/);
  });
});
