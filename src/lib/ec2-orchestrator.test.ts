import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OrchestratorError,
  resolveOrchestratorConfig,
  run,
} from "./ec2-orchestrator.js";

const FIXTURE_DISCOVERY = "DISCOVERY: target={{RALPH_TARGET_REPO}} branch={{RALPH_DEFAULT_BRANCH}}";
const FIXTURE_IMPL = "IMPL: target={{RALPH_TARGET_REPO}} stuck={{RALPH_AGENT_STUCK_LABEL}} tag={{RALPH_LAUNCH_TAG}}";
const FIXTURE_REVIEW = "REVIEW: pr={{RALPH_PR_NUMBER}} branch={{RALPH_PR_BRANCH}}";

interface Harness {
  outDir: string;
  packageRoot: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  const promptsDir = join(root, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "discovery.md"), FIXTURE_DISCOVERY);
  writeFileSync(join(promptsDir, "implementation.md"), FIXTURE_IMPL);
  writeFileSync(join(promptsDir, "review.md"), FIXTURE_REVIEW);
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  return {
    outDir,
    packageRoot: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("resolveOrchestratorConfig", () => {
  it("throws OrchestratorError(2) when RALPH_TARGET_REPO is unset", () => {
    expect(() => resolveOrchestratorConfig({}, "/pkg")).toThrowError(
      OrchestratorError,
    );
  });

  it("populates defaults", () => {
    const c = resolveOrchestratorConfig(
      { RALPH_TARGET_REPO: "x/y" },
      "/pkg",
    );
    expect(c.outDir).toBe("/tmp/ralph");
    expect(c.discoveryPromptPath).toBe("/pkg/prompts/discovery.md");
    expect(c.reviewWaitSec).toBe(600);
  });

  it("RALPH_REVIEW_WAIT_SEC=0 is honoured (skip-sleep semantics)", () => {
    const c = resolveOrchestratorConfig(
      { RALPH_TARGET_REPO: "x/y", RALPH_REVIEW_WAIT_SEC: "0" },
      "/pkg",
    );
    expect(c.reviewWaitSec).toBe(0);
  });

  it("malformed RALPH_REVIEW_WAIT_SEC falls back to default", () => {
    const c = resolveOrchestratorConfig(
      { RALPH_TARGET_REPO: "x/y", RALPH_REVIEW_WAIT_SEC: "not-a-number" },
      "/pkg",
    );
    expect(c.reviewWaitSec).toBe(600);
  });
});

describe("run — full state machine", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  function baseEnv(): NodeJS.ProcessEnv {
    return {
      RALPH_TARGET_REPO: "x/y",
      RALPH_WORK_DIR: h.outDir,
      RALPH_DEFAULT_BRANCH: "main",
      RALPH_OUT_DIR: h.outDir,
      RALPH_LAUNCH_TAG: "tag-1",
      // No RALPH_CONFIG — orchestrator falls back to empty config values.
    };
  }

  it("decision=NONE → emits OUTCOME=no_work, exits 0", async () => {
    const lines: string[] = [];
    const claudeCalls: string[] = [];
    const claude = async (prompt: string) => {
      claudeCalls.push(prompt);
      writeFileSync(
        join(h.outDir, "decision.json"),
        '{"status":"NONE","reasoning":"no candidates"}',
      );
      writeFileSync(join(h.outDir, "issue.json"), "{}");
      writeFileSync(join(h.outDir, "crafted-prompt.md"), "");
      writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      return { exitCode: 0 };
    };
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: (l) => lines.push(l),
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(0);
    expect(claudeCalls[0]).toContain("DISCOVERY: target=x/y branch=main");
    expect(lines).toContain("OUTCOME=no_work");
    expect(lines.some((l) => l.startsWith("PHASE_START phase=discovery"))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith("PHASE_END phase=discovery"))).toBe(
      true,
    );
    // Implementation phase markers must NOT appear on a NONE branch.
    expect(
      lines.some((l) => l.startsWith("PHASE_START phase=implementation")),
    ).toBe(false);
  });

  it("decision=ALL_BLOCKED → emits OUTCOME=all_blocked", async () => {
    const lines: string[] = [];
    const claude = async () => {
      writeFileSync(
        join(h.outDir, "decision.json"),
        '{"status":"ALL_BLOCKED","reasoning":"blocked"}',
      );
      writeFileSync(join(h.outDir, "issue.json"), "{}");
      writeFileSync(join(h.outDir, "crafted-prompt.md"), "");
      writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      return { exitCode: 0 };
    };
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: (l) => lines.push(l),
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(0);
    expect(lines).toContain("OUTCOME=all_blocked");
  });

  it("decision=PICKED → AGENT_STUCK → emits PICKED_ISSUE + OUTCOME=agent_stuck", async () => {
    const lines: string[] = [];
    let phase = 0;
    const claude = async () => {
      phase += 1;
      if (phase === 1) {
        writeFileSync(
          join(h.outDir, "decision.json"),
          '{"status":"PICKED","issue":42,"reasoning":"go"}',
        );
        writeFileSync(join(h.outDir, "issue.json"), "{}");
        writeFileSync(join(h.outDir, "crafted-prompt.md"), "ctx");
        writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      } else if (phase === 2) {
        writeFileSync(
          join(h.outDir, "impl-result.json"),
          '{"status":"AGENT_STUCK","issue":42,"reason":"missing context"}',
        );
      }
      return { exitCode: 0 };
    };
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: (l) => lines.push(l),
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(0);
    expect(lines).toContain("PICKED_ISSUE=42");
    expect(lines).toContain("OUTCOME=agent_stuck issue=42");
    expect(
      lines.some((l) =>
        l.startsWith("PHASE_END phase=implementation") &&
        l.includes("status=AGENT_STUCK"),
      ),
    ).toBe(true);
  });

  it("decision=PICKED → PR_OPENED → REVISION_APPLIED → OUTCOME=pr_opened review=revised", async () => {
    const lines: string[] = [];
    let phase = 0;
    const claudePrompts: string[] = [];
    const claude = async (prompt: string) => {
      phase += 1;
      claudePrompts.push(prompt);
      if (phase === 1) {
        writeFileSync(
          join(h.outDir, "decision.json"),
          '{"status":"PICKED","issue":7,"reasoning":"go"}',
        );
        writeFileSync(join(h.outDir, "issue.json"), "{}");
        writeFileSync(
          join(h.outDir, "crafted-prompt.md"),
          "CRAFTED-CTX-FOR-IMPL",
        );
        writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      } else if (phase === 2) {
        writeFileSync(
          join(h.outDir, "impl-result.json"),
          '{"status":"PR_OPENED","issue":7,"pr_number":91,"pr_url":"https://github.com/x/y/pull/91","branch":"ralph/7-x"}',
        );
      } else if (phase === 3) {
        writeFileSync(
          join(h.outDir, "review-result.json"),
          '{"status":"REVISION_APPLIED","summary":"applied"}',
        );
      }
      return { exitCode: 0 };
    };
    const sleeps: number[] = [];
    const rc = await run({
      env: { ...baseEnv(), RALPH_REVIEW_WAIT_SEC: "0" },
      packageRoot: h.packageRoot,
      claude,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      sink: (l) => lines.push(l),
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(0);
    expect(lines).toContain("PICKED_ISSUE=7");
    expect(lines).toContain("OUTCOME=pr_opened issue=7 pr=91 review=revised");
    // Impl prompt must include the crafted context appended after the
    // template (matching iteration-1's bash port).
    expect(claudePrompts[1]).toContain("Crafted context from discovery");
    expect(claudePrompts[1]).toContain("CRAFTED-CTX-FOR-IMPL");
    // Review prompt sees the rendered PR number/branch.
    expect(claudePrompts[2]).toContain("REVIEW: pr=91 branch=ralph/7-x");
    // Sleep was suppressed by RALPH_REVIEW_WAIT_SEC=0.
    expect(sleeps).toEqual([]);
  });

  it("decision=PICKED → PR_OPENED → NO_REVIEW → OUTCOME=pr_opened review=none", async () => {
    const lines: string[] = [];
    let phase = 0;
    const claude = async () => {
      phase += 1;
      if (phase === 1) {
        writeFileSync(
          join(h.outDir, "decision.json"),
          '{"status":"PICKED","issue":1,"reasoning":""}',
        );
        writeFileSync(join(h.outDir, "issue.json"), "{}");
        writeFileSync(join(h.outDir, "crafted-prompt.md"), "");
        writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      } else if (phase === 2) {
        writeFileSync(
          join(h.outDir, "impl-result.json"),
          '{"status":"PR_OPENED","issue":1,"pr_number":2,"pr_url":"https://github.com/x/y/pull/2","branch":"ralph/1-x"}',
        );
      } else if (phase === 3) {
        writeFileSync(
          join(h.outDir, "review-result.json"),
          '{"status":"NO_REVIEW"}',
        );
      }
      return { exitCode: 0 };
    };
    const rc = await run({
      env: { ...baseEnv(), RALPH_REVIEW_WAIT_SEC: "0" },
      packageRoot: h.packageRoot,
      claude,
      sleep: async () => {},
      sink: (l) => lines.push(l),
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(0);
    expect(lines).toContain("OUTCOME=pr_opened issue=1 pr=2 review=none");
  });

  it("missing decision.json → exit 3", async () => {
    const claude = async () => {
      // Don't write any contract files.
      return { exitCode: 0 };
    };
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: () => {},
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(3);
  });

  it("claude discovery non-zero exit → exit 1", async () => {
    const claude = async () => ({ exitCode: 5 });
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: () => {},
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(1);
  });

  it("invalid impl-result.json → exit 3", async () => {
    let phase = 0;
    const claude = async () => {
      phase += 1;
      if (phase === 1) {
        writeFileSync(
          join(h.outDir, "decision.json"),
          '{"status":"PICKED","issue":1,"reasoning":"go"}',
        );
        writeFileSync(join(h.outDir, "issue.json"), "{}");
        writeFileSync(join(h.outDir, "crafted-prompt.md"), "");
        writeFileSync(join(h.outDir, "milestone-log.json"), "{}");
      } else {
        writeFileSync(
          join(h.outDir, "impl-result.json"),
          '{"status":"WAT","issue":1}',
        );
      }
      return { exitCode: 0 };
    };
    const rc = await run({
      env: baseEnv(),
      packageRoot: h.packageRoot,
      claude,
      sink: () => {},
      runSystemSetup: async () => {},
    });
    expect(rc).toBe(3);
  });
});
