// cwagent → file → stream integration test (issue #38).
//
// The bug this guards against: in v1.0.0 the user-data stub redirected
// stdout/stderr to `/var/log/ralph-user-data.log`, while the cloudwatch-
// agent config in `system-setup.sh` only tailed `/var/log/ralph.log`.
// Both modules' own unit tests passed because neither one exercised the
// boundary. The orchestrator phases ran, but every line was orphaned in a
// file the agent never saw.
//
// This is a structural boundary test — no AWS, no shell. We parse the
// rendered user-data and the shipped `system-setup.sh`, extract the file
// paths each side names, and assert the sets agree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { renderUserData, type UserDataInput } from "./user-data-renderer.js";

const here = dirname(fileURLToPath(import.meta.url));
const systemSetupPath = resolvePath(
  here,
  "..",
  "..",
  "lib",
  "cloud-init",
  "system-setup.sh",
);

const baseInput: UserDataInput = {
  targetRepo: "unimatrix27/ralph-harness",
  harnessVersion: "1.0.0",
  awsRegion: "eu-central-1",
  logGroup: "/ralph/main",
  githubTokenSsmKey: "/ralph/github-pat",
  claudeOauthSsmKey: "/ralph/claude-oauth-credential",
  agentStuckLabel: "agent-stuck",
};

// extractRedirectTargets — find every absolute log path referenced by an
// `exec >(... /path) 2>&1` or `tee -a /path` in the user-data stub. Returns
// the set of paths under /var/log.
function extractRedirectTargets(userData: string): Set<string> {
  const out = new Set<string>();
  const teeRe = /tee\s+(?:-[a-zA-Z]+\s+)*(\/var\/log\/[A-Za-z0-9._-]+)/g;
  for (const m of userData.matchAll(teeRe)) {
    out.add(m[1]!);
  }
  const redirRe = />\s*(\/var\/log\/[A-Za-z0-9._-]+)/g;
  for (const m of userData.matchAll(redirRe)) {
    out.add(m[1]!);
  }
  return out;
}

// extractCwagentFilePaths — pull every `"file_path": "/var/log/..."` line
// from the cwagent JSON config block embedded in system-setup.sh.
function extractCwagentFilePaths(setupSh: string): Set<string> {
  const out = new Set<string>();
  // The config uses bash variable interpolation like ${LOG_FILE}; we expand
  // those by also extracting the variable assignments above the heredoc.
  const vars = new Map<string, string>();
  for (const m of setupSh.matchAll(/^([A-Z_][A-Z0-9_]*)="(\/var\/log\/[^"]+)"/gm)) {
    vars.set(m[1]!, m[2]!);
  }
  const fileRe = /"file_path"\s*:\s*"([^"]+)"/g;
  for (const m of setupSh.matchAll(fileRe)) {
    let path = m[1]!;
    path = path.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => {
      return vars.get(k) ?? `\${${k}}`;
    });
    if (path.startsWith("/var/log/")) out.add(path);
  }
  return out;
}

describe("cwagent → file → stream wiring", () => {
  it("user-data redirects stdout into a file path the cwagent config watches", () => {
    const userData = renderUserData(baseInput);
    const redirected = extractRedirectTargets(userData);
    const setupSh = readFileSync(systemSetupPath, "utf8");
    const watched = extractCwagentFilePaths(setupSh);

    expect(redirected.size).toBeGreaterThan(0);
    expect(watched.size).toBeGreaterThan(0);

    // Every file the user-data stub writes must be tailed by the agent.
    // (The agent may additionally tail files the stub does not write — e.g.
    // cloud-init-output.log — and that is fine.)
    for (const path of redirected) {
      expect(watched.has(path)).toBe(true);
    }
  });

  it("system-setup.sh declares LOG_FILE and uses it in the cwagent config", () => {
    const setupSh = readFileSync(systemSetupPath, "utf8");
    expect(setupSh).toMatch(/^LOG_FILE="\/var\/log\/[^"]+"/m);
    expect(setupSh).toMatch(/"file_path"\s*:\s*"\$\{LOG_FILE\}"/);
  });

  it("the cwagent log_group_name resolves from RALPH_LOG_GROUP", () => {
    const setupSh = readFileSync(systemSetupPath, "utf8");
    expect(setupSh).toMatch(
      /"log_group_name"\s*:\s*"\$\{RALPH_LOG_GROUP\}"/,
    );
  });

  it("the cwagent log_stream_name uses the per-instance LOG_STREAM (so post-hoc lookups land)", () => {
    const setupSh = readFileSync(systemSetupPath, "utf8");
    expect(setupSh).toMatch(/LOG_STREAM="\$\{INSTANCE_ID:-/);
    expect(setupSh).toMatch(/"log_stream_name"\s*:\s*"\$\{LOG_STREAM\}"/);
  });
});
