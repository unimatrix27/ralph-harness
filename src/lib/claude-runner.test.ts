// claude-runner — pure-helper coverage. The subprocess pipe is exercised
// indirectly via a stub binary; we test resolution + argv shape directly,
// then run a stub `claude` to confirm stdin → child works end-to-end.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildArgv,
  resolveBin,
  resolveFlags,
  runClaude,
} from "./claude-runner.js";

describe("resolveFlags", () => {
  it("returns the default permission-mode flag when no env is set", () => {
    expect(resolveFlags({})).toBe("--permission-mode bypassPermissions");
  });

  it("uses RALPH_CLAUDE_FLAGS verbatim when set", () => {
    expect(resolveFlags({ RALPH_CLAUDE_FLAGS: "--foo --bar baz" })).toBe(
      "--foo --bar baz",
    );
  });

  it("RALPH_DEBUG_TRANSCRIPT=1 selects the stream-json + verbose set", () => {
    expect(resolveFlags({ RALPH_DEBUG_TRANSCRIPT: "1" })).toBe(
      "--permission-mode bypassPermissions --output-format stream-json --verbose",
    );
  });

  it("RALPH_DEBUG_TRANSCRIPT=1 wins over an explicit RALPH_CLAUDE_FLAGS", () => {
    expect(
      resolveFlags({
        RALPH_DEBUG_TRANSCRIPT: "1",
        RALPH_CLAUDE_FLAGS: "--anything",
      }),
    ).toContain("--output-format stream-json");
  });
});

describe("resolveBin", () => {
  it("defaults to `claude`", () => {
    expect(resolveBin({})).toBe("claude");
  });

  it("honours RALPH_CLAUDE_BIN", () => {
    expect(resolveBin({ RALPH_CLAUDE_BIN: "/usr/local/bin/claude-stub" })).toBe(
      "/usr/local/bin/claude-stub",
    );
  });
});

describe("buildArgv", () => {
  it("prepends --print and splits flag string on whitespace", () => {
    expect(buildArgv("--permission-mode bypassPermissions")).toEqual([
      "--print",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("appends --model when supplied", () => {
    expect(buildArgv("--permission-mode bypassPermissions", "claude-opus-4-7")).toEqual([
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-opus-4-7",
    ]);
  });

  it("collapses runs of whitespace and ignores empty fragments", () => {
    expect(buildArgv("  --foo   --bar  ")).toEqual([
      "--print",
      "--foo",
      "--bar",
    ]);
  });
});

describe("runClaude (subprocess via stub binary)", () => {
  let stubDir: string;
  const STUB = `#!/usr/bin/env bash
# Stub: prints argv, then echoes stdin, then exits with $CLAUDE_STUB_EXIT (0).
printf 'argv=%s\\n' "$*"
cat
exit "\${CLAUDE_STUB_EXIT:-0}"
`;

  beforeEach(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), "claude-runner-stub-"));
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(resolve(stubDir, "claude"), STUB, { mode: 0o755 });
  });

  afterEach(() => {
    // mkdtempSync directory cleanup is best-effort; vitest leaves it alone.
  });

  it("pipes the prompt to the child's stdin and forwards stdout", async () => {
    const sinks = makeSinks();
    const r = await runClaude("hello prompt", {
      bin: resolve(stubDir, "claude"),
      flags: "--permission-mode bypassPermissions",
      stdout: sinks.outStream,
      stderr: sinks.errStream,
    });
    expect(r.exitCode).toBe(0);
    const out = sinks.outChunks.toString();
    expect(out).toContain("argv=--print --permission-mode bypassPermissions");
    expect(out).toContain("hello prompt");
  });

  it("propagates a non-zero exit code from the child", async () => {
    const sinks = makeSinks();
    const r = await runClaude("x", {
      bin: resolve(stubDir, "claude"),
      flags: "",
      env: { CLAUDE_STUB_EXIT: "7", PATH: process.env.PATH ?? "" },
      stdout: sinks.outStream,
      stderr: sinks.errStream,
    });
    expect(r.exitCode).toBe(7);
  });
});

interface Sinks {
  outChunks: Buffer;
  errChunks: Buffer;
  outStream: NodeJS.WritableStream;
  errStream: NodeJS.WritableStream;
}

function makeSinks(): Sinks {
  let outBuf = Buffer.alloc(0);
  let errBuf = Buffer.alloc(0);
  const outStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      outBuf = Buffer.concat([outBuf, chunk]);
      cb();
    },
  });
  const errStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      errBuf = Buffer.concat([errBuf, chunk]);
      cb();
    },
  });
  return {
    get outChunks() { return outBuf; },
    get errChunks() { return errBuf; },
    outStream,
    errStream,
  };
}
