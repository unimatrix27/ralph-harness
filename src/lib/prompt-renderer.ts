// prompt-renderer — pure {{...}} substitution for the harness prompt
// templates. Replaces the bash parameter-expansion blocks in iteration-1's
// ec2-orchestrator.sh.
//
// Contract:
//   render(template, context) — returns a new string with every `{{KEY}}`
//   occurrence replaced by `context[KEY]`. Keys are matched literally (no
//   surrounding whitespace allowed inside the braces — the legacy bash port
//   never produced any). Missing keys are left as the literal placeholder
//   `{{KEY}}`; the call does NOT throw, mirroring the bash behaviour where an
//   unset variable expanded to empty *or* untouched depending on quoting. We
//   pick "leave untouched" so a missing-key bug is grep-visible in the
//   rendered output rather than silently swallowed.
//
//   Escape: a `{{KEY}}` placeholder preceded by a backslash (`\{{KEY}}`) is
//   emitted as the literal `{{KEY}}` with the backslash stripped — escape
//   hatch for documentation that has to mention placeholder syntax verbatim.

export const MODULE_PREFIX = "prompt-renderer";

export type PromptContext = Readonly<Record<string, string>>;

const PLACEHOLDER_RE = /(\\)?\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function render(template: string, context: PromptContext): string {
  return template.replace(PLACEHOLDER_RE, (match, escape: string | undefined, key: string) => {
    if (escape) return `{{${key}}}`;
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return context[key] ?? "";
    }
    return match;
  });
}
