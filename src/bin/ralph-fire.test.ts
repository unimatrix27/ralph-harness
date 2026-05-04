import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-fire.ts");
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

function runFire(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
  });
}

describe("ralph-fire", () => {
  it("--version prints the package version and exits 0", () => {
    const result = runFire(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("rejects unknown invocations with a non-zero exit", () => {
    const result = runFire([]);
    expect(result.status).not.toBe(0);
  });
});
