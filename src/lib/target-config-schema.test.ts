import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  ValidateError,
  readSchemaVersion,
  validate,
} from "./target-config-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixDir = resolve(here, "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(resolve(fixDir, name), "utf8");
}

describe("validate (pure)", () => {
  it("accepts a valid minimal config and returns the typed value", () => {
    const cfg = validate(readFixture("valid-minimal.yaml"));
    expect(cfg.build_cmd).toBe("make build");
    expect(cfg.test_cmd).toBe("make test");
    expect(cfg.branch_prefix).toBe("ralph");
    expect(cfg.review_bot.username).toBe("claude");
    expect(cfg.review_bot.source).toBe("comment");
  });

  it("accepts a valid full config including prompt_extensions", () => {
    const cfg = validate(readFixture("valid-full.yaml"));
    expect(cfg.agent_stuck_label).toBe("agent-stuck");
    expect(cfg.prompt_extensions?.discovery).toContain("priority:high");
    expect(cfg.prompt_extensions?.implementation).toContain("CONTEXT.md");
    expect(cfg.prompt_extensions?.review).toContain("blocking");
  });

  it("rejects malformed yaml with exit code 3", () => {
    expect.assertions(3);
    try {
      validate(readFixture("malformed.yaml"));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidateError);
      expect((err as ValidateError).code).toBe(3);
      expect((err as ValidateError).message).toMatch(/malformed yaml/);
    }
  });

  it("rejects a missing required field with exit code 4", () => {
    expect.assertions(3);
    try {
      validate(readFixture("missing-required.yaml"));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidateError);
      expect((err as ValidateError).code).toBe(4);
      expect((err as ValidateError).message).toMatch(
        /missing required field.*build_cmd/,
      );
    }
  });

  it("rejects an unknown top-level field with exit code 5", () => {
    expect.assertions(3);
    try {
      validate(readFixture("unknown-field.yaml"));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidateError);
      expect((err as ValidateError).code).toBe(5);
      expect((err as ValidateError).message).toMatch(
        /unknown field.*unexpected_key/,
      );
    }
  });

  it("rejects a wrong-type required field with exit code 6", () => {
    expect.assertions(3);
    try {
      validate(readFixture("wrong-type.yaml"));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidateError);
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(
        /build_cmd.*must be a string/,
      );
    }
  });
});

describe("validate (programmatic edge cases not in the bats matrix)", () => {
  it("rejects a non-mapping top level (list) with exit code 6", () => {
    expect.assertions(2);
    try {
      validate("- a\n- b\n");
    } catch (err) {
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(/top-level must be a mapping/);
    }
  });

  it("rejects an empty document with exit code 6", () => {
    expect.assertions(2);
    try {
      validate("");
    } catch (err) {
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(/top-level must be a mapping/);
    }
  });

  it("rejects branch_prefix containing '/' with exit code 6", () => {
    const yaml = [
      'build_cmd: "make build"',
      'test_cmd: "make test"',
      'branch_prefix: "ralph/sub"',
      "review_bot:",
      '  username: "claude"',
      '  source: "comment"',
      "",
    ].join("\n");
    expect.assertions(2);
    try {
      validate(yaml);
    } catch (err) {
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(/branch_prefix/);
    }
  });

  it("rejects review_bot.source not in {comment,review} with exit code 6", () => {
    const yaml = [
      'build_cmd: "make build"',
      'test_cmd: "make test"',
      'branch_prefix: "ralph"',
      "review_bot:",
      '  username: "claude"',
      '  source: "review-summary"',
      "",
    ].join("\n");
    expect.assertions(2);
    try {
      validate(yaml);
    } catch (err) {
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(/review_bot\.source/);
    }
  });

  it("rejects an unknown sub-key under review_bot with exit code 5", () => {
    const yaml = [
      'build_cmd: "make build"',
      'test_cmd: "make test"',
      'branch_prefix: "ralph"',
      "review_bot:",
      '  username: "claude"',
      '  source: "comment"',
      '  extra: "nope"',
      "",
    ].join("\n");
    expect.assertions(2);
    try {
      validate(yaml);
    } catch (err) {
      expect((err as ValidateError).code).toBe(5);
      expect((err as ValidateError).message).toMatch(/review_bot.*extra/);
    }
  });

  it("accepts an explicit schema_version matching CURRENT_SCHEMA_VERSION", () => {
    const yaml = [
      `schema_version: ${CURRENT_SCHEMA_VERSION}`,
      'build_cmd: "make build"',
      'test_cmd: "make test"',
      'branch_prefix: "ralph"',
      "review_bot:",
      '  username: "claude"',
      '  source: "comment"',
      "",
    ].join("\n");
    expect(() => validate(yaml)).not.toThrow();
  });

  it("rejects an unsupported schema_version (forces operator migration)", () => {
    const yaml = [
      "schema_version: 99",
      'build_cmd: "make build"',
      'test_cmd: "make test"',
      'branch_prefix: "ralph"',
      "review_bot:",
      '  username: "claude"',
      '  source: "comment"',
      "",
    ].join("\n");
    expect.assertions(1);
    try {
      validate(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidateError);
    }
  });

  it("readSchemaVersion returns the declared version (or undefined when absent)", () => {
    expect(readSchemaVersion("schema_version: 1\nbuild_cmd: x\n")).toBe(1);
    expect(readSchemaVersion("build_cmd: x\n")).toBeUndefined();
    expect(readSchemaVersion("not: { yaml")).toBeUndefined();
  });

  it("rejects an empty string for a required field with exit code 6", () => {
    const yaml = [
      'build_cmd: ""',
      'test_cmd: "make test"',
      'branch_prefix: "ralph"',
      "review_bot:",
      '  username: "claude"',
      '  source: "comment"',
      "",
    ].join("\n");
    expect.assertions(2);
    try {
      validate(yaml);
    } catch (err) {
      expect((err as ValidateError).code).toBe(6);
      expect((err as ValidateError).message).toMatch(/build_cmd/);
    }
  });
});
