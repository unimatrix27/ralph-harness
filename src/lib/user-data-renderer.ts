// user-data-renderer — renders the small inline bash stub that EC2 receives
// as user-data. Iteration 1 bundled the entire bash harness (`fire-launcher`
// + `ec2-orchestrator` + `cloud-init/bootstrap`) inline, which forced gzip
// compression to fit under the 16 KiB cap. Iteration 2 ships the harness via
// npm; the user-data shrinks to ~15 lines that install Node 24, install the
// harness package, then `exec ralph-orchestrate`.
//
// Cap-check: EC2's user-data cap is 16,384 bytes on the *raw* decoded
// payload — NOT on the base64 wire form, NOT on the gzipped bytes. PR #20
// and #21 (iteration 1) checked the gzipped size against this dimension,
// which let oversized payloads slip through when gzip happened to compress
// well. We check the raw rendered bytes here; the new stub is well under
// the cap so a `RawSizeExceeded` throw should be the equivalent of an
// assertion failure rather than a regular operating condition.
//
// Public surface:
//   renderUserData(input)        — returns the rendered bash string
//   USER_DATA_CAP_BYTES          — the EC2 16 KiB cap (raw bytes)
//   RawSizeExceededError         — thrown when the rendered output exceeds the cap

export const MODULE_PREFIX = "user-data-renderer";

// EC2 caps user-data at 16,384 raw decoded bytes. cf.
// docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html
export const USER_DATA_CAP_BYTES = 16_384;

export class RawSizeExceededError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `${MODULE_PREFIX}: rendered user-data is ${bytes} bytes, exceeds the EC2 cap of ${USER_DATA_CAP_BYTES} raw bytes`,
    );
    this.name = "RawSizeExceededError";
  }
}

export interface UserDataInput {
  // Operator-supplied. All required.
  targetRepo: string;       // owner/repo
  harnessVersion: string;   // package version (e.g. "1.0.0"); operator override via RALPH_HARNESS_VERSION
  awsRegion: string;
  logGroup: string;
  githubTokenSsmKey: string;
  claudeOauthSsmKey: string;
  agentStuckLabel: string;
  // Optional. Pass-through env vars set in the EC2 shell so the orchestrator
  // sees them. Use sparingly — keep the user-data small.
  extraEnv?: Readonly<Record<string, string>>;
  // Optional. Override the npm package name when piloting a fork. Default:
  // the production registry name.
  packageName?: string;
}

const DEFAULT_PACKAGE_NAME = "@unimatrix27/ralph-harness";

// shellSingleQuote — wrap a value in POSIX single quotes, escaping any
// embedded `'` as `'\''`. Single-quoted strings are safe against every
// other shell metacharacter.
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderUserData(input: UserDataInput): string {
  const pkg = input.packageName ?? DEFAULT_PACKAGE_NAME;
  // Build the export block deterministically — sorted keys keep the
  // snapshot test stable across object literal reorders.
  const baseEnv: Record<string, string> = {
    RALPH_TARGET_REPO: input.targetRepo,
    RALPH_AWS_REGION: input.awsRegion,
    RALPH_LOG_GROUP: input.logGroup,
    RALPH_GITHUB_TOKEN_SSM_KEY: input.githubTokenSsmKey,
    RALPH_CLAUDE_OAUTH_SSM_KEY: input.claudeOauthSsmKey,
    RALPH_AGENT_STUCK_LABEL: input.agentStuckLabel,
    RALPH_HARNESS_VERSION: input.harnessVersion,
  };
  const merged: Record<string, string> = { ...baseEnv, ...(input.extraEnv ?? {}) };
  const sortedKeys = Object.keys(merged).sort();
  const exports = sortedKeys
    .map((k) => `export ${k}=${shellSingleQuote(merged[k]!)}`)
    .join("\n");

  // 15-line target — keep this tight. Anything heavyweight goes in
  // `lib/cloud-init/system-setup.sh` (shipped inside the npm package and
  // invoked by `ralph-orchestrate` as its first step).
  //
  // The `trap … EXIT` hook (issue #37) emits a sentinel line for the
  // launcher's CloudWatch backstop and runs `shutdown -h now` on any
  // exit so the EC2 instance terminates immediately on orchestrator
  // failure instead of sitting idle until the wall-clock ceiling. The
  // body uses double-quoted single quotes so $rc is expanded by the
  // shell at trap-fire time, not at template render time. We do NOT
  // `exec ralph-orchestrate` because exec replaces the shell and the
  // trap would never fire.
  const stub = `#!/bin/bash
set -uo pipefail
exec > >(tee -a /var/log/ralph.log) 2>&1
trap 'rc=$?; printf "ORCHESTRATOR_EXITED rc=%s\\n" "$rc"; shutdown -h now' EXIT
${exports}
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs git jq awscli
npm install -g ${pkg}@${input.harnessVersion}
ralph-orchestrate
`;

  const bytes = Buffer.byteLength(stub, "utf8");
  if (bytes > USER_DATA_CAP_BYTES) {
    throw new RawSizeExceededError(bytes);
  }
  return stub;
}
