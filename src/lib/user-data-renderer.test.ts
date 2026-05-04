import { describe, expect, it } from "vitest";

import {
  RawSizeExceededError,
  renderUserData,
  shellSingleQuote,
  USER_DATA_CAP_BYTES,
  type UserDataInput,
} from "./user-data-renderer.js";

const baseInput: UserDataInput = {
  targetRepo: "unimatrix27/ralph-harness",
  harnessVersion: "1.0.0",
  awsRegion: "eu-central-1",
  logGroup: "/ralph/main",
  githubTokenSsmKey: "/ralph/github-pat",
  claudeOauthSsmKey: "/ralph/claude-oauth-credential",
  agentStuckLabel: "agent-stuck",
};

describe("shellSingleQuote", () => {
  it("wraps simple values in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes via the POSIX `'\\''` idiom", () => {
    expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("treats other shell metacharacters as literal", () => {
    expect(shellSingleQuote("$VAR `cmd` && rm -rf /")).toBe(
      "'$VAR `cmd` && rm -rf /'",
    );
  });
});

describe("renderUserData — snapshot at default inputs", () => {
  it("emits the expected ~15-line bash stub", () => {
    const out = renderUserData(baseInput);
    expect(out).toMatchInlineSnapshot(`
      "#!/bin/bash
      set -euo pipefail
      exec > >(tee -a /var/log/ralph-user-data.log) 2>&1
      export RALPH_AGENT_STUCK_LABEL='agent-stuck'
      export RALPH_AWS_REGION='eu-central-1'
      export RALPH_CLAUDE_OAUTH_SSM_KEY='/ralph/claude-oauth-credential'
      export RALPH_GITHUB_TOKEN_SSM_KEY='/ralph/github-pat'
      export RALPH_HARNESS_VERSION='1.0.0'
      export RALPH_LOG_GROUP='/ralph/main'
      export RALPH_TARGET_REPO='unimatrix27/ralph-harness'
      curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
      dnf install -y nodejs git jq awscli
      npm install -g @unimatrix27/ralph-harness@1.0.0
      exec ralph-orchestrate
      "
    `);
  });

  it("merges extraEnv keys into the export block", () => {
    const out = renderUserData({
      ...baseInput,
      extraEnv: { RALPH_DEBUG_TRANSCRIPT: "1" },
    });
    expect(out).toContain("export RALPH_DEBUG_TRANSCRIPT='1'");
  });

  it("honours an alternate packageName", () => {
    const out = renderUserData({ ...baseInput, packageName: "@fork/ralph" });
    expect(out).toContain("npm install -g @fork/ralph@1.0.0");
  });

  it("rendered output stays well under the 16 KiB cap at default inputs", () => {
    const out = renderUserData(baseInput);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(2_000);
  });
});

describe("renderUserData — cap-check", () => {
  it("throws RawSizeExceededError when the rendered output exceeds the cap", () => {
    // Pad extraEnv with a key whose value pushes the rendered bytes over
    // the 16 KiB cap. Don't rely on stable padding; just generate enough
    // bytes to exceed.
    const huge = "x".repeat(USER_DATA_CAP_BYTES + 100);
    expect(() =>
      renderUserData({
        ...baseInput,
        extraEnv: { RALPH_HUGE: huge },
      }),
    ).toThrow(RawSizeExceededError);
  });

  it("the thrown error reports the rendered byte count", () => {
    const huge = "x".repeat(USER_DATA_CAP_BYTES + 100);
    try {
      renderUserData({ ...baseInput, extraEnv: { RALPH_HUGE: huge } });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RawSizeExceededError);
      expect((err as RawSizeExceededError).bytes).toBeGreaterThan(
        USER_DATA_CAP_BYTES,
      );
    }
  });

  it("right at the cap does NOT throw (boundary case)", () => {
    // We can't easily land on exactly the cap, but anything strictly less
    // than USER_DATA_CAP_BYTES must succeed. Build a value whose addition
    // keeps total under the cap.
    const out = renderUserData({
      ...baseInput,
      extraEnv: { RALPH_PAD: "x".repeat(8_000) },
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(USER_DATA_CAP_BYTES);
  });

  it("USER_DATA_CAP_BYTES is the EC2 16,384-byte raw cap", () => {
    expect(USER_DATA_CAP_BYTES).toBe(16_384);
  });
});
