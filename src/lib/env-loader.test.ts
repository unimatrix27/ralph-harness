import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverDotenvPaths,
  loadDotenv,
  parseDotenv,
} from "./env-loader.js";

describe("parseDotenv — happy path", () => {
  it("KEY=VALUE", () => {
    expect(parseDotenv("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("multiple lines with mixed forms", () => {
    const src = [
      "A=1",
      "B = 2",
      'C="three"',
      "D='four'",
      "",
      "# comment",
      "E=trailing-ws   ",
      "F=value # inline comment",
    ].join("\n");
    expect(parseDotenv(src)).toEqual({
      A: "1",
      B: "2",
      C: "three",
      D: "four",
      E: "trailing-ws",
      F: "value",
    });
  });

  it("preserves leading whitespace inside double-quoted values", () => {
    expect(parseDotenv('A="  spaced  "')).toEqual({ A: "  spaced  " });
  });

  it("preserves a literal `#` inside quoted values", () => {
    expect(parseDotenv('A="value # not a comment"')).toEqual({
      A: "value # not a comment",
    });
  });
});

describe("parseDotenv — edge cases", () => {
  it("empty content yields {}", () => {
    expect(parseDotenv("")).toEqual({});
  });

  it("blank and whitespace-only lines are skipped", () => {
    expect(parseDotenv("\n   \n\t\n")).toEqual({});
  });

  it("malformed lines (no `=`) are silently skipped", () => {
    expect(parseDotenv("not-a-pair\nA=1\nalso bad")).toEqual({ A: "1" });
  });

  it("rejects keys that don't start with [A-Za-z_]", () => {
    expect(parseDotenv("1ABC=x")).toEqual({});
    expect(parseDotenv("-FOO=x")).toEqual({});
  });

  it("allows underscored and digit-bearing keys", () => {
    expect(parseDotenv("RALPH_API_KEY_2=ok")).toEqual({
      RALPH_API_KEY_2: "ok",
    });
  });

  it("treats `=value` as malformed (no key)", () => {
    expect(parseDotenv("=oops")).toEqual({});
  });

  it("empty value", () => {
    expect(parseDotenv("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("comment lines with leading whitespace are skipped", () => {
    expect(parseDotenv("   # leading space comment\nA=1")).toEqual({ A: "1" });
  });

  it("strips a UTF-8 BOM at start of file", () => {
    expect(parseDotenv("﻿A=1")).toEqual({ A: "1" });
  });

  it("trailing single quote without leading is treated as literal", () => {
    expect(parseDotenv("A=value'")).toEqual({ A: "value'" });
  });
});

describe("discoverDotenvPaths", () => {
  it("returns CWD .env then ~/.config/ralph/.env", () => {
    const paths = discoverDotenvPaths({
      cwd: "/cwd",
      homeDir: "/home/x",
    });
    expect(paths).toEqual(["/cwd/.env", "/home/x/.config/ralph/.env"]);
  });

  it("honours XDG_CONFIG_HOME when supplied", () => {
    const paths = discoverDotenvPaths({
      cwd: "/cwd",
      homeDir: "/home/x",
      xdgConfigHome: "/xdg",
    });
    expect(paths).toEqual(["/cwd/.env", "/xdg/ralph/.env"]);
  });
});

describe("loadDotenv", () => {
  let dir: string;
  let cwd: string;
  let xdg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-loader-"));
    cwd = join(dir, "cwd");
    xdg = join(dir, "xdg");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(xdg, "ralph"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads keys from CWD .env and applies them to env", () => {
    writeFileSync(join(cwd, ".env"), "FOO=cwd\n");
    const env: NodeJS.ProcessEnv = {};
    const summary = loadDotenv({ cwd, xdgConfigHome: xdg, env });
    expect(env.FOO).toBe("cwd");
    expect(summary.applied).toBe(1);
    expect(summary.loaded).toContain(join(cwd, ".env"));
  });

  it("CWD beats XDG when both define the same key", () => {
    writeFileSync(join(cwd, ".env"), "FOO=cwd\n");
    writeFileSync(join(xdg, "ralph", ".env"), "FOO=xdg\nBAR=xdg\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotenv({ cwd, xdgConfigHome: xdg, env });
    expect(env.FOO).toBe("cwd");
    expect(env.BAR).toBe("xdg");
  });

  it("never overrides a key already present in env", () => {
    writeFileSync(join(cwd, ".env"), "FOO=cwd\n");
    const env: NodeJS.ProcessEnv = { FOO: "preset" };
    const summary = loadDotenv({ cwd, xdgConfigHome: xdg, env });
    expect(env.FOO).toBe("preset");
    expect(summary.skippedNoOverride).toBe(1);
    expect(summary.applied).toBe(0);
  });

  it("missing files are silently skipped", () => {
    const env: NodeJS.ProcessEnv = {};
    const summary = loadDotenv({ cwd, xdgConfigHome: xdg, env });
    expect(summary.loaded).toEqual([]);
    expect(summary.applied).toBe(0);
  });

  it("returns the list of loaded paths", () => {
    writeFileSync(join(cwd, ".env"), "A=1\n");
    writeFileSync(join(xdg, "ralph", ".env"), "B=2\n");
    const summary = loadDotenv({
      cwd,
      xdgConfigHome: xdg,
      env: {},
    });
    expect(summary.loaded).toEqual([
      join(cwd, ".env"),
      join(xdg, "ralph", ".env"),
    ]);
  });
});
