import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CLI smoke tests for ralph-gsm. We stub `gh` by putting a tiny shell script
// (functionally equivalent to tests/stubs/gh from the bats suite) on PATH —
// records each invocation to a log file, emits canned stdout via env vars.

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ralph-gsm.ts");

const STUB_SCRIPT = `#!/usr/bin/env bash
if [[ -n "\${GH_STUB_LOG:-}" ]]; then
  {
    printf '=== gh call ===\\n'
    printf 'argc=%s\\n' "$#"
    for a in "$@"; do printf 'arg=%s\\n' "$a"; done
  } >> "$GH_STUB_LOG"
fi
key=""
if (( $# >= 2 )); then
  key=$(printf '%s_%s' "$1" "$2" | tr '[:lower:]-' '[:upper:]_')
fi
out_var="GH_STUB_OUT_\${key:-DEFAULT}"
exit_var="GH_STUB_EXIT_\${key:-DEFAULT}"
if [[ -n "\${!out_var:-}" ]]; then
  printf '%s\\n' "\${!out_var}"
elif [[ -n "\${GH_STUB_OUT:-}" ]]; then
  printf '%s\\n' "\$GH_STUB_OUT"
fi
exit "\${!exit_var:-\${GH_STUB_EXIT:-0}}"
`;

let stubDir: string;
let logPath: string;

beforeEach(() => {
  stubDir = mkdtempSync(resolve(tmpdir(), "ralph-gsm-stub-"));
  mkdirSync(stubDir, { recursive: true });
  const stubBin = resolve(stubDir, "gh");
  writeFileSync(stubBin, STUB_SCRIPT, { mode: 0o755 });
  logPath = resolve(stubDir, "gh.log");
  writeFileSync(logPath, "");
});

afterEach(() => {
  // tmp dir cleanup: leave to the OS — these are tiny.
});

interface RunOpts {
  env?: Record<string, string>;
}

function runCli(args: string[], opts: RunOpts = {}) {
  const env = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    GH_STUB_LOG: logPath,
    ...(opts.env ?? {}),
  };
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    env,
  });
}

function ghLog(): string {
  return readFileSync(logPath, "utf8");
}

describe("ralph-gsm — drop-in for bin/gsm", () => {
  it("no command exits 2 with a usage message", () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it("--help exits 0 and prints usage", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/swap-label/);
  });

  it("unknown command exits 2", () => {
    const r = runCli(["bogus"]);
    expect(r.status).toBe(2);
  });

  it("swap-label invokes gh issue view + edit when state needs changing", () => {
    const r = runCli(["swap-label", "owner/repo", "42", "rfa", "rfh"], {
      env: {
        GH_STUB_OUT_ISSUE_VIEW: JSON.stringify({
          labels: [{ name: "rfa" }, { name: "bug" }],
        }),
      },
    });
    expect(r.status).toBe(0);
    const log = ghLog();
    expect(log).toMatch(/^arg=issue$/m);
    expect(log).toMatch(/^arg=view$/m);
    expect(log).toMatch(/^arg=edit$/m);
    expect(log).toMatch(/^arg=--remove-label$/m);
    expect(log).toMatch(/^arg=rfa$/m);
    expect(log).toMatch(/^arg=--add-label$/m);
    expect(log).toMatch(/^arg=rfh$/m);
  });

  it("swap-label is a no-op (no edit call) when target label already applied", () => {
    const r = runCli(["swap-label", "owner/repo", "42", "rfa", "rfh"], {
      env: {
        GH_STUB_OUT_ISSUE_VIEW: JSON.stringify({
          labels: [{ name: "rfh" }, { name: "bug" }],
        }),
      },
    });
    expect(r.status).toBe(0);
    expect(ghLog()).not.toMatch(/^arg=edit$/m);
  });

  it("swap-label with too few args exits 2", () => {
    const r = runCli(["swap-label", "owner/repo", "42"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/expected 4 args/);
  });

  it("comment-issue posts the body via gh issue comment", () => {
    const r = runCli(["comment-issue", "owner/repo", "99", "hello world"]);
    expect(r.status).toBe(0);
    const log = ghLog();
    expect(log).toMatch(/^arg=comment$/m);
    expect(log).toMatch(/^arg=99$/m);
    expect(log).toMatch(/^arg=hello world$/m);
  });

  it("find-or-create-log echoes existing issue number when found", () => {
    const r = runCli(["find-or-create-log", "owner/repo", "M1"], {
      env: {
        GH_STUB_OUT_ISSUE_LIST: JSON.stringify([
          { number: 123, title: "[log] M1" },
        ]),
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("123");
    expect(ghLog()).not.toMatch(/^arg=create$/m);
  });

  it("find-or-create-log creates and echoes the new number when missing", () => {
    const r = runCli(["find-or-create-log", "owner/repo", "M1"], {
      env: {
        GH_STUB_OUT_ISSUE_LIST: "[]",
        GH_STUB_OUT_ISSUE_CREATE: "https://github.com/owner/repo/issues/777",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("777");
    const log = ghLog();
    expect(log).toMatch(/^arg=create$/m);
    expect(log).toMatch(/^arg=\[log\] M1$/m);
    expect(log).toMatch(/^arg=meta:milestone-log$/m);
  });

  it("append-caveman-log formats #N | summary | gotcha", () => {
    const r = runCli([
      "append-caveman-log",
      "owner/repo",
      "100",
      "42",
      "added validator",
      "yq required",
    ]);
    expect(r.status).toBe(0);
    expect(ghLog()).toMatch(/^arg=#42 \| added validator \| yq required$/m);
  });

  it("append-caveman-log renders empty gotcha as a dash", () => {
    const r = runCli([
      "append-caveman-log",
      "owner/repo",
      "100",
      "42",
      "added validator",
      "",
    ]);
    expect(r.status).toBe(0);
    expect(ghLog()).toMatch(/^arg=#42 \| added validator \| -$/m);
  });

  it("append-caveman-log gotcha argument is optional", () => {
    const r = runCli([
      "append-caveman-log",
      "owner/repo",
      "100",
      "42",
      "added validator",
    ]);
    expect(r.status).toBe(0);
    expect(ghLog()).toMatch(/^arg=#42 \| added validator \| -$/m);
  });

  it("propagates non-zero gh exit codes", () => {
    const r = runCli(["comment-issue", "owner/repo", "99", "hi"], {
      env: { GH_STUB_EXIT_ISSUE_COMMENT: "1" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/github-state-mutator: error:/);
  });
});
