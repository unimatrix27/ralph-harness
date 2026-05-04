// CLI smoke tests for ralph-sync-credential. The credential-syncer logic is
// unit-tested at the lib level (src/lib/credential-syncer.test.ts); here we
// cover argv/usage contract.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-sync-credential.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

describe("ralph-sync-credential — drop-in for bin/sync-credential.sh", () => {
  it("exits 2 when given more than one positional argument", () => {
    const r = runCli(["one", "two"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
