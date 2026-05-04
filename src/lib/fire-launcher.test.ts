import { describe, expect, it } from "vitest";

import {
  DEFAULTS,
  LauncherError,
  resolveLauncherConfig,
  waitForTerminated,
} from "./fire-launcher.js";

describe("resolveLauncherConfig", () => {
  it("throws LauncherError(2) when RALPH_TARGET_REPO is unset", () => {
    try {
      resolveLauncherConfig({}, "1.0.0");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LauncherError);
      expect((err as LauncherError).exitCode).toBe(2);
      expect((err as Error).message).toContain("RALPH_TARGET_REPO");
    }
  });

  it("populates iteration-1 defaults when only RALPH_TARGET_REPO is set", () => {
    const c = resolveLauncherConfig(
      { RALPH_TARGET_REPO: "x/y" },
      "1.0.0",
    );
    expect(c.region).toBe(DEFAULTS.region);
    expect(c.logGroup).toBe(DEFAULTS.logGroup);
    expect(c.instanceType).toBe(DEFAULTS.instanceType);
    expect(c.rootVolumeGb).toBe(DEFAULTS.rootVolumeGb);
    expect(c.maxLifetimeMin).toBe(DEFAULTS.maxLifetimeMin);
    expect(c.pollIntervalSec).toBe(DEFAULTS.pollIntervalSec);
    expect(c.harnessVersion).toBe("1.0.0");
  });

  it("RALPH_HARNESS_VERSION overrides the launcher's package version", () => {
    const c = resolveLauncherConfig(
      { RALPH_TARGET_REPO: "x/y", RALPH_HARNESS_VERSION: "2.3.4" },
      "1.0.0",
    );
    expect(c.harnessVersion).toBe("2.3.4");
  });

  it("rejects non-positive numeric env vars and falls back to defaults", () => {
    const c = resolveLauncherConfig(
      {
        RALPH_TARGET_REPO: "x/y",
        RALPH_MAX_LIFETIME_MIN: "0",
        RALPH_POLL_INTERVAL_SEC: "abc",
        RALPH_ROOT_VOLUME_GB: "-5",
      },
      "1.0.0",
    );
    expect(c.maxLifetimeMin).toBe(DEFAULTS.maxLifetimeMin);
    expect(c.pollIntervalSec).toBe(DEFAULTS.pollIntervalSec);
    expect(c.rootVolumeGb).toBe(DEFAULTS.rootVolumeGb);
  });

  it("honours RALPH_AGENT_STUCK_LABEL override", () => {
    const c = resolveLauncherConfig(
      { RALPH_TARGET_REPO: "x/y", RALPH_AGENT_STUCK_LABEL: "custom-stuck" },
      "1.0.0",
    );
    expect(c.agentStuckLabel).toBe("custom-stuck");
  });
});

describe("waitForTerminated", () => {
  it("returns 0 immediately when describe-instances reports terminated", async () => {
    const sends: unknown[] = [];
    const ec2 = {
      send: async (cmd: unknown) => {
        sends.push(cmd);
        return {
          Reservations: [
            { Instances: [{ State: { Name: "terminated" } }] },
          ],
        };
      },
    };
    const lines: string[] = [];
    const rc = await waitForTerminated(
      { ec2 } as never,
      {
        config: {
          maxLifetimeMin: 75,
          pollIntervalSec: 20,
        } as never,
        instanceId: "i-abc",
        info: (l) => lines.push(l),
      },
    );
    expect(rc).toBe(0);
    expect(sends.length).toBe(1);
    expect(lines.some((l) => l.includes("terminated"))).toBe(true);
  });

  it("returns 3 and fires terminate-instances when the wall-clock ceiling breaches", async () => {
    let sendCount = 0;
    let terminateCalled = false;
    const ec2 = {
      send: async (cmd: { constructor: { name: string } }) => {
        sendCount += 1;
        if (cmd.constructor.name === "TerminateInstancesCommand") {
          terminateCalled = true;
          return {};
        }
        return {
          Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
        };
      },
    };
    let virtualNow = 0;
    const rc = await waitForTerminated(
      { ec2 } as never,
      {
        config: {
          maxLifetimeMin: 1, // 60_000ms ceiling
          pollIntervalSec: 1,
        } as never,
        instanceId: "i-abc",
        info: () => {},
        // First call: 0ms (set deadline = 60_000). Second call (after sleep):
        // 60_001ms (past deadline → trigger force-terminate path).
        now: () => virtualNow,
        sleep: async () => {
          virtualNow += 60_001;
        },
      },
    );
    expect(rc).toBe(3);
    expect(terminateCalled).toBe(true);
    expect(sendCount).toBeGreaterThanOrEqual(2);
  });
});
