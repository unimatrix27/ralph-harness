import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsClients } from "./aws-clients.js";
import { postHocCheck } from "./post-hoc-agent-stuck-checker.js";

vi.mock("./gh-runner.js", () => {
  const ghMock = vi.fn();
  class GhRunnerError extends Error {
    constructor(public exitCode: number, public stderr: string, message: string) {
      super(message);
    }
  }
  return {
    runGh: ghMock,
    GhRunnerError,
    __ghMock: ghMock,
  };
});

import * as ghMod from "./gh-runner.js";

const ghMock = (
  ghMod as unknown as { __ghMock: ReturnType<typeof vi.fn> }
).__ghMock;

function makeLogsClient(events: { message: string }[] | "throws") {
  const send = vi.fn(async () => {
    if (events === "throws") throw new Error("logs unreachable");
    return { events };
  });
  return { send } as unknown as AwsClients["logs"];
}

function makeClients(logs: AwsClients["logs"]): AwsClients {
  return {
    kms: {} as never,
    ssm: {} as never,
    iam: {} as never,
    ec2: {} as never,
    sts: {} as never,
    logs,
  };
}

describe("postHocCheck", () => {
  beforeEach(() => ghMock.mockReset());

  it("ClearTermination when a PR carries the launch tag", async () => {
    ghMock.mockReturnValueOnce({
      stdout: JSON.stringify([
        { number: 99, body: "Closes #1\n<!-- ralph-launch: tagX -->" },
      ]),
      stderr: "",
      exitCode: 0,
    });
    const result = await postHocCheck({
      clients: makeClients(makeLogsClient([])),
      targetRepo: "x/y",
      launchTag: "tagX",
      instanceId: "i-abc",
      logGroup: "/ralph/main",
      agentStuckLabel: "agent-stuck",
    });
    expect(result).toEqual({ kind: "ClearTermination", prNumber: 99 });
  });

  it("NoPickedIssueRecoverable when no PR and CloudWatch has nothing", async () => {
    ghMock.mockReturnValueOnce({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
    });
    const result = await postHocCheck({
      clients: makeClients(makeLogsClient([])),
      targetRepo: "x/y",
      launchTag: "tagX",
      instanceId: "i-abc",
      logGroup: "/ralph/main",
      agentStuckLabel: "agent-stuck",
    });
    expect(result).toEqual({ kind: "NoPickedIssueRecoverable" });
  });

  it("AgentStuckLabelApplied when no PR but PICKED_ISSUE marker is present", async () => {
    // 1st call: pr list returns []
    ghMock.mockReturnValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });
    // 2nd call: gh issue edit succeeds
    ghMock.mockReturnValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const result = await postHocCheck({
      clients: makeClients(
        makeLogsClient([
          { message: "PHASE_END phase=discovery duration_s=12 ts=..." },
          { message: "PICKED_ISSUE=42" },
        ]),
      ),
      targetRepo: "x/y",
      launchTag: "tagX",
      instanceId: "i-abc",
      logGroup: "/ralph/main",
      agentStuckLabel: "agent-stuck",
    });
    expect(result).toEqual({ kind: "AgentStuckLabelApplied", issue: 42 });
    // Confirm the gh edit call shape.
    const editCall = ghMock.mock.calls.at(-1);
    expect(editCall?.[0]).toEqual([
      "issue",
      "edit",
      "42",
      "--repo",
      "x/y",
      "--add-label",
      "agent-stuck",
    ]);
  });

  it("CloudWatch failure returns NoPickedIssueRecoverable when no PR", async () => {
    ghMock.mockReturnValueOnce({ stdout: "[]", stderr: "", exitCode: 0 });
    const result = await postHocCheck({
      clients: makeClients(makeLogsClient("throws")),
      targetRepo: "x/y",
      launchTag: "tagX",
      instanceId: "i-abc",
      logGroup: "/ralph/main",
      agentStuckLabel: "agent-stuck",
    });
    expect(result).toEqual({ kind: "NoPickedIssueRecoverable" });
  });

  it("info sink receives the diagnostic trail", async () => {
    ghMock.mockReturnValueOnce({
      stdout: JSON.stringify([
        { number: 5, body: "<!-- ralph-launch: T -->" },
      ]),
      stderr: "",
      exitCode: 0,
    });
    const lines: string[] = [];
    await postHocCheck({
      clients: makeClients(makeLogsClient([])),
      targetRepo: "x/y",
      launchTag: "T",
      instanceId: "i-abc",
      logGroup: "/ralph/main",
      agentStuckLabel: "agent-stuck",
      info: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("PR #5"))).toBe(true);
  });
});

