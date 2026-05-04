import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh-runner.js", () => {
  const calls: { args: string[] }[] = [];
  let nextStdoutQueue: string[] = [];
  let nextThrowQueue: (Error | undefined)[] = [];

  function runGh(args: readonly string[]) {
    calls.push({ args: [...args] });
    const err = nextThrowQueue.shift();
    if (err) throw err;
    const stdout = nextStdoutQueue.shift() ?? "";
    return { stdout, stderr: "", exitCode: 0 };
  }

  function __reset() {
    calls.length = 0;
    nextStdoutQueue = [];
    nextThrowQueue = [];
  }
  function __queueStdout(...outputs: string[]) {
    nextStdoutQueue.push(...outputs);
  }
  function __queueThrow(...errs: (Error | undefined)[]) {
    nextThrowQueue.push(...errs);
  }
  function __calls() {
    return calls;
  }

  class GhRunnerError extends Error {
    constructor(
      public readonly exitCode: number,
      public readonly stderr: string,
      message: string,
    ) {
      super(message);
      this.name = "GhRunnerError";
    }
  }

  return {
    runGh,
    runGhJson: () => {
      throw new Error("not used in this test");
    },
    GhRunnerError,
    __reset,
    __queueStdout,
    __queueThrow,
    __calls,
  };
});

import {
  appendCavemanLog,
  commentIssue,
  findOrCreateMilestoneLogIssue,
  swapLabel,
} from "./github-state-mutator.js";

const ghRunner = (await import("./gh-runner.js")) as unknown as {
  __reset: () => void;
  __queueStdout: (...s: string[]) => void;
  __queueThrow: (...errs: (Error | undefined)[]) => void;
  __calls: () => { args: string[] }[];
  GhRunnerError: typeof Error;
};

beforeEach(() => {
  ghRunner.__reset();
});

afterEach(() => {
  ghRunner.__reset();
});

function labelsPayload(...names: string[]): string {
  return JSON.stringify({ labels: names.map((name) => ({ name })) });
}

describe("swapLabel", () => {
  it("removes from-label and adds to-label when both states need changing", () => {
    ghRunner.__queueStdout(
      labelsPayload("ready-for-agent", "bug"),
      "", // edit call's stdout (not used)
    );
    swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human");
    const calls = ghRunner.__calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "issue",
      "view",
      "42",
      "--repo",
      "owner/repo",
      "--json",
      "labels",
    ]);
    expect(calls[1]?.args).toEqual([
      "issue",
      "edit",
      "42",
      "--repo",
      "owner/repo",
      "--remove-label",
      "ready-for-agent",
      "--add-label",
      "ready-for-human",
    ]);
  });

  it("idempotent when target label already applied — second call also no-op", () => {
    // First call: state already matches → only the view call happens.
    ghRunner.__queueStdout(labelsPayload("ready-for-human", "bug"));
    swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human");
    expect(ghRunner.__calls()).toHaveLength(1);
    expect(ghRunner.__calls()[0]?.args[1]).toBe("view");

    // Second call: still same state → still only a view, no edit.
    ghRunner.__queueStdout(labelsPayload("ready-for-human", "bug"));
    swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human");
    expect(ghRunner.__calls()).toHaveLength(2);
    expect(ghRunner.__calls()[1]?.args[1]).toBe("view");
    expect(
      ghRunner.__calls().some((c) => c.args[1] === "edit"),
    ).toBe(false);
  });

  it("only adds when neither label present", () => {
    ghRunner.__queueStdout(labelsPayload("bug"), "");
    swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human");
    const calls = ghRunner.__calls();
    expect(calls[1]?.args).toContain("--add-label");
    expect(calls[1]?.args).not.toContain("--remove-label");
  });

  it("only removes when from present and to also already present", () => {
    ghRunner.__queueStdout(
      labelsPayload("ready-for-agent", "ready-for-human"),
      "",
    );
    swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human");
    const calls = ghRunner.__calls();
    expect(calls[1]?.args).toContain("--remove-label");
    expect(calls[1]?.args).not.toContain("--add-label");
  });

  it("propagates a GhRunnerError when gh issue view fails", () => {
    const boom = new ghRunner.GhRunnerError(1, "boom", "gh failed") as Error;
    ghRunner.__queueThrow(boom);
    expect(() =>
      swapLabel("owner/repo", 42, "ready-for-agent", "ready-for-human"),
    ).toThrow(/gh failed/);
  });
});

describe("commentIssue", () => {
  it("posts to the right issue with the right body", () => {
    ghRunner.__queueStdout("");
    commentIssue("owner/repo", 99, "hello world");
    const calls = ghRunner.__calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "issue",
      "comment",
      "99",
      "--repo",
      "owner/repo",
      "--body",
      "hello world",
    ]);
  });

  it("preserves bash semantics — second call posts a second comment (append-only)", () => {
    ghRunner.__queueStdout("", "");
    commentIssue("owner/repo", 99, "hello");
    commentIssue("owner/repo", 99, "hello");
    const editCalls = ghRunner
      .__calls()
      .filter((c) => c.args[1] === "comment");
    expect(editCalls).toHaveLength(2);
  });

  it("propagates a GhRunnerError when gh fails", () => {
    const boom = new ghRunner.GhRunnerError(1, "boom", "gh failed") as Error;
    ghRunner.__queueThrow(boom);
    expect(() => commentIssue("owner/repo", 99, "hi")).toThrow(/gh failed/);
  });
});

describe("findOrCreateMilestoneLogIssue", () => {
  it("returns existing issue number when found, with no create call", () => {
    ghRunner.__queueStdout(
      JSON.stringify([
        { number: 100, title: "[log] M-other" },
        { number: 123, title: "[log] M1" },
      ]),
    );
    const n = findOrCreateMilestoneLogIssue("owner/repo", "M1");
    expect(n).toBe(123);
    const calls = ghRunner.__calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("list");
    expect(calls[0]?.args).toContain("meta:milestone-log");
  });

  it("idempotent — second call also reuses the existing issue (no second create)", () => {
    ghRunner.__queueStdout(
      JSON.stringify([{ number: 123, title: "[log] M1" }]),
      JSON.stringify([{ number: 123, title: "[log] M1" }]),
    );
    expect(findOrCreateMilestoneLogIssue("owner/repo", "M1")).toBe(123);
    expect(findOrCreateMilestoneLogIssue("owner/repo", "M1")).toBe(123);
    const calls = ghRunner.__calls();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.args[1] === "list")).toBe(true);
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  it("creates issue when missing and echoes the new number", () => {
    ghRunner.__queueStdout(
      JSON.stringify([]),
      "https://github.com/owner/repo/issues/777\n",
    );
    const n = findOrCreateMilestoneLogIssue("owner/repo", "M1");
    expect(n).toBe(777);
    const calls = ghRunner.__calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("create");
    expect(calls[1]?.args).toContain("--title");
    expect(calls[1]?.args).toContain("[log] M1");
    expect(calls[1]?.args).toContain("--label");
    expect(calls[1]?.args).toContain("meta:milestone-log");
    expect(calls[1]?.args).toContain("--body");
  });

  it("throws when gh stdout is malformed JSON on the list call", () => {
    ghRunner.__queueStdout("not-json");
    expect(() => findOrCreateMilestoneLogIssue("owner/repo", "M1")).toThrow(
      /could not parse/,
    );
  });
});

describe("appendCavemanLog", () => {
  it("formats the comment as #N | summary | gotcha", () => {
    ghRunner.__queueStdout("");
    appendCavemanLog("owner/repo", 100, 42, "added validator", "yq required");
    const calls = ghRunner.__calls();
    expect(calls[0]?.args).toContain("#42 | added validator | yq required");
  });

  it("empty gotcha is rendered as a dash", () => {
    ghRunner.__queueStdout("");
    appendCavemanLog("owner/repo", 100, 42, "added validator", "");
    expect(ghRunner.__calls()[0]?.args).toContain(
      "#42 | added validator | -",
    );
  });

  it("gotcha argument is optional", () => {
    ghRunner.__queueStdout("");
    appendCavemanLog("owner/repo", 100, 42, "added validator");
    expect(ghRunner.__calls()[0]?.args).toContain(
      "#42 | added validator | -",
    );
  });

  it("preserves bash semantics — second call posts a second log line", () => {
    ghRunner.__queueStdout("", "");
    appendCavemanLog("owner/repo", 100, 42, "x");
    appendCavemanLog("owner/repo", 100, 42, "x");
    expect(
      ghRunner.__calls().filter((c) => c.args[1] === "comment"),
    ).toHaveLength(2);
  });

  it("propagates a GhRunnerError from gh", () => {
    const boom = new ghRunner.GhRunnerError(1, "boom", "gh failed") as Error;
    ghRunner.__queueThrow(boom);
    expect(() =>
      appendCavemanLog("owner/repo", 100, 42, "x"),
    ).toThrow(/gh failed/);
  });
});
