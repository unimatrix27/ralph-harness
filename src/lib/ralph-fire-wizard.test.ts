import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseGithubRepoFromGitUrl,
  runWizard,
  type WizardIO,
} from "./ralph-fire-wizard.js";

describe("parseGithubRepoFromGitUrl", () => {
  it("parses HTTPS form with .git suffix", () => {
    expect(
      parseGithubRepoFromGitUrl("https://github.com/unimatrix27/ralph.git"),
    ).toBe("unimatrix27/ralph");
  });
  it("parses HTTPS form without .git suffix", () => {
    expect(
      parseGithubRepoFromGitUrl("https://github.com/unimatrix27/ralph"),
    ).toBe("unimatrix27/ralph");
  });
  it("parses HTTPS form with auth prefix (gh CLI rewrites)", () => {
    expect(
      parseGithubRepoFromGitUrl(
        "https://x-access-token:ghp_abc@github.com/unimatrix27/ralph.git",
      ),
    ).toBe("unimatrix27/ralph");
  });
  it("parses SSH form", () => {
    expect(
      parseGithubRepoFromGitUrl("git@github.com:unimatrix27/ralph.git"),
    ).toBe("unimatrix27/ralph");
  });
  it("returns null for non-github hosts", () => {
    expect(
      parseGithubRepoFromGitUrl("https://gitlab.com/foo/bar.git"),
    ).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(parseGithubRepoFromGitUrl("")).toBeNull();
    expect(parseGithubRepoFromGitUrl("   ")).toBeNull();
  });
  it("returns null for malformed input", () => {
    expect(parseGithubRepoFromGitUrl("not a url")).toBeNull();
  });
});

// fakeIo — a queued-answer prompt mock. Records every prompt and returns
// answers from the supplied queue in order.
function fakeIo(answers: string[]): {
  io: WizardIO;
  questions: string[];
  infos: string[];
} {
  const questions: string[] = [];
  const infos: string[] = [];
  const queue = [...answers];
  const io: WizardIO = {
    ask: async (q: string) => {
      questions.push(q);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`fakeIo: unexpected prompt "${q}"`);
      }
      return next;
    },
    info: (line: string) => infos.push(line),
  };
  return { io, questions, infos };
}

describe("runWizard", () => {
  it("is a no-op when not on a TTY (CI / user-data path preserved)", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { io, questions } = fakeIo([]);
    await runWizard({
      env,
      isTty: false,
      io,
      gitRemote: () => "https://github.com/x/y.git",
    });
    expect(env.RALPH_TARGET_REPO).toBeUndefined();
    expect(questions.length).toBe(0);
  });

  it("auto-discovers RALPH_TARGET_REPO from git remote and confirms with the operator", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { io, questions } = fakeIo([
      "", // confirm Y for target_repo (default Y on empty)
      "", // accept default region
    ]);
    await runWizard({
      env,
      isTty: true,
      io,
      gitRemote: () => "https://github.com/unimatrix27/ralph.git",
    });
    expect(env.RALPH_TARGET_REPO).toBe("unimatrix27/ralph");
    expect(env.RALPH_AWS_REGION).toBe("eu-central-1");
    expect(questions[0]).toContain("unimatrix27/ralph");
  });

  it("falls back to manual prompt when operator declines auto-discovered repo", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { io } = fakeIo([
      "n", // decline auto-discovered
      "different-owner/different-repo", // typed override
      "us-east-1", // region override
    ]);
    await runWizard({
      env,
      isTty: true,
      io,
      gitRemote: () => "https://github.com/auto/discovered.git",
    });
    expect(env.RALPH_TARGET_REPO).toBe("different-owner/different-repo");
    expect(env.RALPH_AWS_REGION).toBe("us-east-1");
  });

  it("re-prompts on malformed manual input", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { io, infos } = fakeIo([
      "n",
      "not a slash repo",
      "owner/repo",
      "",
    ]);
    await runWizard({
      env,
      isTty: true,
      io,
      gitRemote: () => "https://github.com/auto/discovered.git",
    });
    expect(env.RALPH_TARGET_REPO).toBe("owner/repo");
    expect(infos.some((l) => l.includes("expected the form owner/repo"))).toBe(
      true,
    );
  });

  it("operator-typed RALPH_TARGET_REPO always wins over auto-discovery", async () => {
    const env: NodeJS.ProcessEnv = { RALPH_TARGET_REPO: "operator/wins" };
    const { io, questions } = fakeIo([""]); // only the region prompt
    await runWizard({
      env,
      isTty: true,
      io,
      gitRemote: () => "https://github.com/should/not-be-asked.git",
    });
    expect(env.RALPH_TARGET_REPO).toBe("operator/wins");
    // Only the region prompt should have appeared.
    expect(questions.length).toBe(1);
    expect(questions[0]).toContain("RALPH_AWS_REGION");
  });

  it("prompts for manual entry when cwd has no git remote", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { io, questions } = fakeIo(["typed/manually", ""]);
    await runWizard({
      env,
      isTty: true,
      io,
      gitRemote: () => null,
    });
    expect(env.RALPH_TARGET_REPO).toBe("typed/manually");
    expect(questions[0]).toContain("RALPH_TARGET_REPO");
  });

  it("warns when local .ralph/config.yaml is missing schema_version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-wizard-"));
    try {
      mkdirSync(join(dir, ".ralph"));
      writeFileSync(
        join(dir, ".ralph", "config.yaml"),
        "build_cmd: 'true'\ntest_cmd: 'true'\nbranch_prefix: ralph\nreview_bot:\n  username: bot\n  source: comment\n",
      );
      const env: NodeJS.ProcessEnv = { RALPH_TARGET_REPO: "x/y", RALPH_AWS_REGION: "eu-central-1" };
      const { io, infos } = fakeIo([]);
      await runWizard({ env, cwd: dir, isTty: true, io });
      expect(infos.some((l) => l.includes("schema_version"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when local config declares a schema_version different from CURRENT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-wizard-"));
    try {
      mkdirSync(join(dir, ".ralph"));
      writeFileSync(
        join(dir, ".ralph", "config.yaml"),
        "schema_version: 99\nbuild_cmd: 'true'\ntest_cmd: 'true'\nbranch_prefix: ralph\nreview_bot:\n  username: bot\n  source: comment\n",
      );
      const env: NodeJS.ProcessEnv = { RALPH_TARGET_REPO: "x/y", RALPH_AWS_REGION: "eu-central-1" };
      const { io, infos } = fakeIo([]);
      await runWizard({ env, cwd: dir, isTty: true, io });
      expect(
        infos.some(
          (l) =>
            l.includes("schema_version=99") &&
            l.includes("harness expects 1"),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
