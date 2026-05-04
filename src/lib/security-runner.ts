// security-runner — thin subprocess wrapper around macOS `security` for the
// one operation credential-syncer needs: read a generic-password Keychain
// entry by service name.
//
// Exists for the same reason gh-runner does — so credential-syncer can be
// unit-tested by mocking exactly one module instead of stubbing a binary on
// PATH.
//
// Contract:
//   readGenericPassword(service)
//     - exit 0   → resolve with the stdout bytes (the password value)
//     - exit ≠ 0 → throw SecurityRunnerError (the Keychain entry is missing
//                  or the service is mistyped)
//
// Security: the password value is only ever returned from this function as
// the resolved string. It is never passed on argv to any subsequent process,
// never logged, and never included in any error message thrown by this
// module.

import { spawnSync } from "node:child_process";

const MODULE_PREFIX = "security-runner";

export class SecurityRunnerError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "SecurityRunnerError";
  }
}

// readGenericPassword — runs `security find-generic-password -s <service> -w`
// and returns the raw password bytes (no trailing newline trimming — the
// caller decides). Throws SecurityRunnerError on non-zero exit.
export function readGenericPassword(service: string): string {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-w"],
    { encoding: "utf8" },
  );

  if (r.error) {
    throw new SecurityRunnerError(
      -1,
      "",
      `${MODULE_PREFIX}: failed to spawn security: ${r.error.message}`,
    );
  }

  const exitCode = r.status ?? -1;
  const stderr = r.stderr ?? "";

  if (exitCode !== 0) {
    throw new SecurityRunnerError(
      exitCode,
      stderr,
      `${MODULE_PREFIX}: security find-generic-password -s '${service}' failed (exit ${exitCode})`,
    );
  }

  // `security -w` emits the password on stdout followed by a single newline.
  // Strip exactly one trailing newline so the caller gets the bytes the user
  // stored. (Some Keychain entries legitimately contain trailing newlines;
  // matches the `out=$(security ...)` stripping done by the bash port.)
  let stdout = r.stdout ?? "";
  if (stdout.endsWith("\n")) stdout = stdout.slice(0, -1);
  return stdout;
}
