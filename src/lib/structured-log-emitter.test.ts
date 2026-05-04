import { describe, expect, it } from "vitest";

import {
  Emitter,
  nowUtc,
  outcome,
  phaseEnd,
  phaseStart,
  pickedIssue,
  type Clock,
} from "./structured-log-emitter.js";

const FIXED_TS = "2026-05-04T11:43:57Z";
const fixedClock: Clock = () => new Date("2026-05-04T11:43:57.123Z");

describe("structured-log-emitter — golden strings", () => {
  it("nowUtc emits seconds-precision UTC ISO without fractional millis", () => {
    expect(nowUtc(fixedClock)).toBe(FIXED_TS);
  });

  it("PHASE_START phase=discovery", () => {
    expect(
      phaseStart({ phase: "discovery", ts: FIXED_TS, target: "unimatrix27/ralph-harness" }),
    ).toBe(
      "PHASE_START phase=discovery ts=2026-05-04T11:43:57Z target=unimatrix27/ralph-harness",
    );
  });

  it("PHASE_START phase=discovery falls back to target=unknown", () => {
    expect(phaseStart({ phase: "discovery", ts: FIXED_TS })).toBe(
      "PHASE_START phase=discovery ts=2026-05-04T11:43:57Z target=unknown",
    );
  });

  it("PHASE_START phase=implementation", () => {
    expect(phaseStart({ phase: "implementation", ts: FIXED_TS, issue: 42 })).toBe(
      "PHASE_START phase=implementation ts=2026-05-04T11:43:57Z issue=42",
    );
  });

  it("PHASE_START phase=review", () => {
    expect(
      phaseStart({ phase: "review", ts: FIXED_TS, issue: 42, pr: 99 }),
    ).toBe("PHASE_START phase=review ts=2026-05-04T11:43:57Z issue=42 pr=99");
  });

  it("PHASE_END phase=discovery", () => {
    expect(phaseEnd({ phase: "discovery", durationSec: 12, ts: FIXED_TS })).toBe(
      "PHASE_END phase=discovery duration_s=12 ts=2026-05-04T11:43:57Z",
    );
  });

  it("PHASE_END phase=implementation", () => {
    expect(
      phaseEnd({
        phase: "implementation",
        durationSec: 600,
        ts: FIXED_TS,
        issue: 42,
        status: "PR_OPENED",
      }),
    ).toBe(
      "PHASE_END phase=implementation duration_s=600 issue=42 status=PR_OPENED ts=2026-05-04T11:43:57Z",
    );
  });

  it("PHASE_END phase=review", () => {
    expect(
      phaseEnd({
        phase: "review",
        durationSec: 30,
        ts: FIXED_TS,
        issue: 42,
        pr: 99,
        status: "REVISION_APPLIED",
      }),
    ).toBe(
      "PHASE_END phase=review duration_s=30 issue=42 pr=99 status=REVISION_APPLIED ts=2026-05-04T11:43:57Z",
    );
  });

  it("PHASE_END status falls back to 'unknown'", () => {
    expect(
      phaseEnd({
        phase: "implementation",
        durationSec: 1,
        ts: FIXED_TS,
        issue: 1,
      }),
    ).toBe(
      "PHASE_END phase=implementation duration_s=1 issue=1 status=unknown ts=2026-05-04T11:43:57Z",
    );
  });

  it("PICKED_ISSUE marker", () => {
    expect(pickedIssue(123)).toBe("PICKED_ISSUE=123");
  });

  it("OUTCOME variants", () => {
    expect(outcome({ kind: "no_work" })).toBe("OUTCOME=no_work");
    expect(outcome({ kind: "all_blocked" })).toBe("OUTCOME=all_blocked");
    expect(outcome({ kind: "agent_stuck", issue: 42 })).toBe(
      "OUTCOME=agent_stuck issue=42",
    );
    expect(
      outcome({ kind: "pr_opened", issue: 42, pr: 99, review: "none" }),
    ).toBe("OUTCOME=pr_opened issue=42 pr=99 review=none");
    expect(
      outcome({ kind: "pr_opened", issue: 42, pr: 99, review: "revised" }),
    ).toBe("OUTCOME=pr_opened issue=42 pr=99 review=revised");
  });
});

describe("structured-log-emitter — Emitter wrapper", () => {
  it("writes lines to the injected sink and returns them", () => {
    const lines: string[] = [];
    const e = new Emitter((l) => lines.push(l), fixedClock);
    const r = e.start({ phase: "discovery", target: "x/y" });
    expect(r).toBe(
      "PHASE_START phase=discovery ts=2026-05-04T11:43:57Z target=x/y",
    );
    expect(lines).toEqual([
      "PHASE_START phase=discovery ts=2026-05-04T11:43:57Z target=x/y",
    ]);
  });

  it("end() interpolates duration + status", () => {
    const lines: string[] = [];
    const e = new Emitter((l) => lines.push(l), fixedClock);
    e.end({
      phase: "implementation",
      durationSec: 7,
      issue: 1,
      status: "AGENT_STUCK",
    });
    expect(lines).toEqual([
      "PHASE_END phase=implementation duration_s=7 issue=1 status=AGENT_STUCK ts=2026-05-04T11:43:57Z",
    ]);
  });
});

describe("structured-log-emitter — required-field guards", () => {
  it("phaseStart implementation throws without issue", () => {
    expect(() =>
      phaseStart({ phase: "implementation", ts: FIXED_TS } as never),
    ).toThrow(/issue is required/);
  });
  it("phaseStart review throws without pr", () => {
    expect(() =>
      phaseStart({ phase: "review", ts: FIXED_TS, issue: 1 } as never),
    ).toThrow(/pr is required/);
  });
});
