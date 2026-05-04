import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseDecision,
  parseImplResult,
  parseMilestoneLog,
  parseReviewResult,
  readDecision,
  readImplResult,
  readMilestoneLog,
  readReviewResult,
  SchemaError,
} from "./phase-result-schemas.js";

describe("DecisionSchema", () => {
  const valid: { name: string; raw: string }[] = [
    {
      name: "PICKED",
      raw: '{"status":"PICKED","issue":42,"reasoning":"because"}',
    },
    {
      name: "NONE",
      raw: '{"status":"NONE","reasoning":"empty"}',
    },
    {
      name: "ALL_BLOCKED",
      raw: '{"status":"ALL_BLOCKED","reasoning":"all blocked"}',
    },
  ];

  for (const { name, raw } of valid) {
    it(`parses ${name}`, () => {
      expect(parseDecision(raw).status).toBe(name);
    });
  }

  const invalid: { name: string; raw: string; match: RegExp }[] = [
    { name: "missing status", raw: "{}", match: /failed schema validation/ },
    {
      name: "PICKED missing issue",
      raw: '{"status":"PICKED","reasoning":"x"}',
      match: /issue/,
    },
    {
      name: "PICKED with non-positive issue",
      raw: '{"status":"PICKED","issue":-1,"reasoning":"x"}',
      match: /issue/,
    },
    {
      name: "non-JSON",
      raw: "not json",
      match: /not valid JSON/,
    },
    {
      name: "unknown status",
      raw: '{"status":"WAT","reasoning":""}',
      match: /failed schema validation/,
    },
  ];

  for (const { name, raw, match } of invalid) {
    it(`rejects: ${name}`, () => {
      expect(() => parseDecision(raw)).toThrow(match);
    });
  }
});

describe("ImplResultSchema", () => {
  it("parses PR_OPENED", () => {
    const r = parseImplResult(
      JSON.stringify({
        status: "PR_OPENED",
        issue: 42,
        pr_number: 99,
        pr_url: "https://github.com/x/y/pull/99",
        branch: "ralph/42-x",
      }),
    );
    if (r.status !== "PR_OPENED") throw new Error("expected PR_OPENED");
    expect(r.pr_number).toBe(99);
    expect(r.branch).toBe("ralph/42-x");
  });

  it("parses AGENT_STUCK", () => {
    const r = parseImplResult(
      '{"status":"AGENT_STUCK","issue":42,"reason":"missing context"}',
    );
    expect(r.status).toBe("AGENT_STUCK");
  });

  it("rejects PR_OPENED with non-URL pr_url", () => {
    expect(() =>
      parseImplResult(
        '{"status":"PR_OPENED","issue":1,"pr_number":1,"pr_url":"not-a-url","branch":"x"}',
      ),
    ).toThrow(/failed schema validation/);
  });

  it("rejects PR_OPENED with empty branch", () => {
    expect(() =>
      parseImplResult(
        '{"status":"PR_OPENED","issue":1,"pr_number":1,"pr_url":"https://x/y/pull/1","branch":""}',
      ),
    ).toThrow(/branch/);
  });
});

describe("ReviewResultSchema", () => {
  it("parses NO_REVIEW (with optional reason)", () => {
    expect(parseReviewResult('{"status":"NO_REVIEW"}').status).toBe(
      "NO_REVIEW",
    );
    expect(
      parseReviewResult('{"status":"NO_REVIEW","reason":"none"}').status,
    ).toBe("NO_REVIEW");
  });

  it("parses REVISION_APPLIED", () => {
    const r = parseReviewResult(
      '{"status":"REVISION_APPLIED","summary":"applied","gotcha":"-"}',
    );
    if (r.status !== "REVISION_APPLIED") throw new Error("expected REVISION_APPLIED");
    expect(r.summary).toBe("applied");
  });

  it("REVISION_APPLIED requires summary", () => {
    expect(() =>
      parseReviewResult('{"status":"REVISION_APPLIED"}'),
    ).toThrow(/summary/);
  });
});

describe("MilestoneLogSchema", () => {
  it("parses {}", () => {
    expect(parseMilestoneLog("{}")).toEqual({});
  });

  it("parses with milestone + log_issue", () => {
    expect(
      parseMilestoneLog('{"milestone":"Iteration 2","log_issue":30}'),
    ).toEqual({ milestone: "Iteration 2", log_issue: 30 });
  });

  it("parses with null log_issue (no-milestone path)", () => {
    expect(
      parseMilestoneLog('{"milestone":"","log_issue":null}'),
    ).toEqual({ milestone: "", log_issue: null });
  });

  it("rejects extra keys on the empty shape", () => {
    expect(() =>
      parseMilestoneLog('{"unexpected":"key"}'),
    ).toThrow(/failed schema validation/);
  });
});

describe("readers attach the file path", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phase-result-schemas-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readDecision: returns parsed value on a valid file", () => {
    const path = join(dir, "decision.json");
    writeFileSync(path, '{"status":"NONE","reasoning":"empty"}');
    expect(readDecision(path).status).toBe("NONE");
  });

  it("readDecision: throws SchemaError with path on a bad file", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json");
    try {
      readDecision(path);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaError);
      expect((err as SchemaError).path).toBe(path);
      expect((err as Error).message).toContain(path);
    }
  });

  it("readImplResult: missing file surfaces as SchemaError", () => {
    expect(() => readImplResult(join(dir, "missing.json"))).toThrow(SchemaError);
  });

  it("readReviewResult: missing file", () => {
    expect(() => readReviewResult(join(dir, "missing.json"))).toThrow(SchemaError);
  });

  it("readMilestoneLog: handles {}", () => {
    const path = join(dir, "milestone-log.json");
    writeFileSync(path, "{}");
    expect(readMilestoneLog(path)).toEqual({});
  });
});
