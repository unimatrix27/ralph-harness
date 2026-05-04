// env-loader — `.env` discovery + parsing for `ralph-fire`. Replaces what
// would otherwise be a `set -a; source .env; set +a` block in the bash port.
//
// Discovery order (first match wins per key, no-override on already-set vars):
//   1. `<cwd>/.env`
//   2. `~/.config/ralph/.env`         (XDG default; honours XDG_CONFIG_HOME
//                                      when set)
//
// Semantics:
//   - already-set process.env keys are NEVER overridden (operator wins)
//   - both files are read when both exist; the CWD file takes precedence
//     for keys that appear in both (mirrors PATH-style "first wins")
//   - quoted values: KEY="value" or KEY='value' — surrounding quotes stripped,
//     no escape processing inside (we never needed it; the bash port didn't
//     interpret backslashes either)
//   - unquoted values: trailing whitespace is trimmed
//   - blank lines, full-line comments (`# ...`), and malformed lines (no
//     `=`) are silently skipped — matches dotenv's "silent malformed" rule
//
// Public surface:
//   discoverDotenvPaths(opts?) — returns the ordered list of paths to try
//   parseDotenv(content)        — returns Record<string,string> from a file body
//   loadDotenv(opts?)           — reads + parses both files, mutates the
//                                 supplied env object (default: process.env),
//                                 honours no-override; returns a summary

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODULE_PREFIX = "env-loader";

export interface DiscoverOptions {
  cwd?: string;
  homeDir?: string;
  xdgConfigHome?: string;
}

export function discoverDotenvPaths(opts: DiscoverOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const xdg = opts.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const xdgRoot = xdg && xdg.length > 0 ? xdg : join(home, ".config");
  return [join(cwd, ".env"), join(xdgRoot, "ralph", ".env")];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, ""); // strip BOM on first line
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no key, or `=value`
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1);
    // Trim leading whitespace (allows `KEY = value` or `KEY=  value`)
    value = value.replace(/^[ \t]+/, "");
    if (value.length >= 2) {
      const first = value[0]!;
      const last = value[value.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      } else {
        // Strip trailing whitespace and any inline comment marker on
        // unquoted values. The dotenv convention is that ` #` introduces
        // a trailing comment ONLY when preceded by whitespace.
        const inlineCommentMatch = value.match(/[ \t]+#.*$/);
        if (inlineCommentMatch) {
          value = value.slice(0, inlineCommentMatch.index);
        }
        value = value.replace(/[ \t]+$/, "");
      }
    } else {
      value = value.replace(/[ \t]+$/, "");
    }
    out[key] = value;
  }
  return out;
}

export interface LoadOptions extends DiscoverOptions {
  env?: NodeJS.ProcessEnv;
}

export interface LoadSummary {
  loaded: string[];          // paths that existed and were read
  applied: number;           // count of keys actually set on env
  skippedNoOverride: number; // count of keys present-but-already-set
}

export function loadDotenv(opts: LoadOptions = {}): LoadSummary {
  const env = opts.env ?? process.env;
  const paths = discoverDotenvPaths(opts);
  const loaded: string[] = [];
  let applied = 0;
  let skippedNoOverride = 0;
  // First-wins across files, then no-override against env. That means we
  // accumulate parsed keys in declaration order, then apply only those that
  // are not already in env.
  const merged: Record<string, string> = {};
  for (const p of paths) {
    let raw: string;
    try {
      const s = statSync(p);
      if (!s.isFile()) continue;
      raw = readFileSync(p, "utf8");
    } catch {
      // missing or unreadable: silently skip (dotenv-style)
      continue;
    }
    loaded.push(p);
    const parsed = parseDotenv(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(merged, k)) {
        merged[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (env[k] !== undefined) {
      skippedNoOverride += 1;
      continue;
    }
    env[k] = v;
    applied += 1;
  }
  return { loaded, applied, skippedNoOverride };
}
