import { describe, expect, it } from "vitest";

import { render } from "./prompt-renderer.js";

describe("prompt-renderer", () => {
  it("substitutes a single placeholder", () => {
    expect(render("hello {{NAME}}", { NAME: "world" })).toBe("hello world");
  });

  it("substitutes multiple placeholders, including repeated keys", () => {
    expect(
      render("{{A}}-{{B}}-{{A}}", { A: "x", B: "y" }),
    ).toBe("x-y-x");
  });

  it("leaves unknown placeholders untouched (visible in output)", () => {
    expect(render("hi {{UNSET}}", {})).toBe("hi {{UNSET}}");
  });

  it("treats a present key with empty string as a real substitution", () => {
    expect(render("[{{X}}]", { X: "" })).toBe("[]");
  });

  it("strips a leading backslash escape and emits the literal placeholder", () => {
    expect(render("escape: \\{{KEY}}", { KEY: "x" })).toBe("escape: {{KEY}}");
  });

  it("returns an empty template unchanged", () => {
    expect(render("", { A: "x" })).toBe("");
  });

  it("does not match braces with internal whitespace", () => {
    // `{{ KEY }}` is left as-is, mirroring the bash port which only ever
    // emitted the no-whitespace form.
    expect(render("hi {{ KEY }}", { KEY: "x" })).toBe("hi {{ KEY }}");
  });

  it("does not recurse into substituted values", () => {
    // If a value happens to contain placeholder syntax, that is preserved
    // verbatim — no second pass.
    expect(
      render("{{A}}", { A: "{{B}}", B: "boom" }),
    ).toBe("{{B}}");
  });
});
