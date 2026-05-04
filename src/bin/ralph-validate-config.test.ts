import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-validate-config.ts");
const fixDir = resolve(here, "..", "lib", "__fixtures__");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
  });
}

function fix(name: string): string {
  return resolve(fixDir, name);
}

describe("ralph-validate-config (CLI — drop-in for bin/load-config)", () => {
  it("valid full config exits 0 with an 'ok:' line", () => {
    const r = runCli([fix("valid-full.yaml")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ok:/);
  });

  it("valid minimal config exits 0", () => {
    const r = runCli([fix("valid-minimal.yaml")]);
    expect(r.status).toBe(0);
  });

  it("missing required field exits 4 and names the missing key", () => {
    const r = runCli([fix("missing-required.yaml")]);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/missing required field/);
    expect(r.stderr).toMatch(/build_cmd/);
  });

  it("malformed yaml exits 3 with a parse error", () => {
    const r = runCli([fix("malformed.yaml")]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/malformed yaml/);
  });

  it("unknown top-level field exits 5 and names the offending key", () => {
    const r = runCli([fix("unknown-field.yaml")]);
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/unknown field/);
    expect(r.stderr).toMatch(/unexpected_key/);
  });

  it("wrong type for required field exits 6 with a 'must be a string' message", () => {
    const r = runCli([fix("wrong-type.yaml")]);
    expect(r.status).toBe(6);
    expect(r.stderr).toMatch(/build_cmd/);
    expect(r.stderr).toMatch(/must be a string/);
  });

  it("missing file exits 2 with a readable 'not found' error", () => {
    const r = runCli([fix("does-not-exist.yaml")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not found/);
  });

  it("no argument exits non-zero with a usage message", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/);
  });

  it("stderr lines are prefixed with the module name on every error path", () => {
    const r = runCli([fix("missing-required.yaml")]);
    expect(r.stderr).toMatch(/^target-config-schema:/);
  });
});
