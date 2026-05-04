// security-runner — exercises the actual `security` subprocess wrapper by
// putting a tiny shell stub on PATH (same pattern as the bats stub +
// src/bin/ralph-gsm.test.ts's `gh` stub).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SecurityRunnerError,
  readGenericPassword,
} from "./security-runner.js";

const STUB_SCRIPT = `#!/usr/bin/env bash
# Tiny security stub. Behavior controlled by env vars:
#   SECURITY_STUB_OUT   — printed to stdout
#   SECURITY_STUB_EXIT  — exit code (default 0)
printf '%s' "\${SECURITY_STUB_OUT:-}"
exit "\${SECURITY_STUB_EXIT:-0}"
`;

let stubDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  stubDir = mkdtempSync(resolve(tmpdir(), "ralph-security-stub-"));
  mkdirSync(stubDir, { recursive: true });
  const stubBin = resolve(stubDir, "security");
  writeFileSync(stubBin, STUB_SCRIPT, { mode: 0o755 });
  originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.SECURITY_STUB_OUT;
  delete process.env.SECURITY_STUB_EXIT;
});

describe("readGenericPassword", () => {
  it("returns the stub stdout (no trailing newline) on exit 0", () => {
    process.env.SECURITY_STUB_OUT = "secret-value\n";
    expect(readGenericPassword("Claude Code-credentials")).toBe(
      "secret-value",
    );
  });

  it("preserves stdout that does not end in a newline", () => {
    process.env.SECURITY_STUB_OUT = "secret-no-trailing-newline";
    expect(readGenericPassword("Claude Code-credentials")).toBe(
      "secret-no-trailing-newline",
    );
  });

  it("returns empty string when the entry is empty (exit 0, empty stdout)", () => {
    process.env.SECURITY_STUB_OUT = "";
    expect(readGenericPassword("Claude Code-credentials")).toBe("");
  });

  it("throws SecurityRunnerError on non-zero exit", () => {
    process.env.SECURITY_STUB_EXIT = "44";
    process.env.SECURITY_STUB_OUT = "";
    expect(() => readGenericPassword("Claude Code-credentials")).toThrow(
      SecurityRunnerError,
    );
  });

  it("error message does not include the password value", () => {
    process.env.SECURITY_STUB_EXIT = "44";
    process.env.SECURITY_STUB_OUT = "";
    try {
      readGenericPassword("Claude Code-credentials");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Claude Code-credentials");
      expect(msg).toContain("exit 44");
    }
  });
});
