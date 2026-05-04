// credential-syncer — extract the macOS Keychain `Claude Code-credentials`
// entry and write it into the SSM SecureString that the EC2 worker reads at
// launch. Re-run after every desktop `claude /login`.
//
// Public surface:
//   syncCredential(opts)
//
// Errors throw CredentialSyncerError with a code field that the CLI maps to
// its exit code.
//
// Exit codes (must match the bash port at lib/credential-syncer.sh —
// preserved across the port so existing operator runbooks/automation read
// the same numbers):
//   0   success (no error thrown)
//   2   usage error                                         (CLI only)
//   3   Keychain entry missing, empty, or not JSON
//   4   AWS credentials not configured
//   1   any other propagated failure
//
// Security:
//   - The credential is read into a single string variable, then passed to
//     the SSM SDK as the request body of PutParameter. It never appears on
//     argv (the SDK marshals it as JSON inside the HTTPS request).
//   - We never log, echo, or include the credential value in any error
//     message. The "not valid JSON" error message also omits the bytes (so
//     a malformed credential doesn't leak via stderr).
//   - The Keychain read goes through src/lib/security-runner — that wrapper
//     is the single point that touches the credential bytes via subprocess.

import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { AWS_REGION, type AwsClients } from "./aws-clients.js";
import {
  SecurityRunnerError,
  readGenericPassword,
} from "./security-runner.js";

export const MODULE_PREFIX = "credential-syncer";

export const DEFAULTS = {
  ssmKey: "/ralph/claude-oauth-credential",
  kmsAlias: "alias/ralph",
  keychainService: "Claude Code-credentials",
} as const;

export type CredentialSyncerExitCode = 1 | 3 | 4;

export class CredentialSyncerError extends Error {
  constructor(
    public readonly code: CredentialSyncerExitCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialSyncerError";
  }
}

export function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

export function moduleInfo(message: string): string {
  return `${MODULE_PREFIX}: ${message}`;
}

export type Logger = (line: string) => void;

const defaultInfo: Logger = (line) => process.stdout.write(`${line}\n`);

// SecurityReader — injection seam for the Keychain read. Defaults to the
// real `security` subprocess wrapper; tests pass a stub.
export type SecurityReader = (service: string) => string;

export interface SyncCredentialOptions {
  clients: AwsClients;
  ssmKey?: string;
  kmsAlias?: string;
  keychainService?: string;
  region?: string;
  info?: Logger;
  readKeychain?: SecurityReader;
}

// syncCredential — read the Keychain entry, validate it parses as JSON, and
// upload it to the SSM SecureString at <ssmKey>. Always overwrites because
// the parameter is created with a placeholder by aws-bootstrap and must be
// updated in place.
export async function syncCredential(
  opts: SyncCredentialOptions,
): Promise<void> {
  const {
    clients,
    ssmKey = DEFAULTS.ssmKey,
    kmsAlias = DEFAULTS.kmsAlias,
    keychainService = DEFAULTS.keychainService,
    region = AWS_REGION,
    info = defaultInfo,
    readKeychain = readGenericPassword,
  } = opts;

  // 1. AWS auth precheck — exits 4 with a useful message if the operator
  //    forgot to authenticate. Cheaper to fail here than after the Keychain
  //    read because the Keychain read can pop a UI prompt on macOS.
  try {
    await clients.sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialSyncerError(
      4,
      moduleErr(
        `AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE. (${detail})`,
      ),
    );
  }

  // 2. Read the Keychain entry. Fail with code 3 on missing/empty/non-JSON.
  let cred: string;
  try {
    cred = readKeychain(keychainService);
  } catch (err) {
    if (err instanceof SecurityRunnerError) {
      throw new CredentialSyncerError(
        3,
        moduleErr(
          `Keychain entry '${keychainService}' not found. Log into the Claude desktop app first (claude /login).`,
        ),
      );
    }
    throw err;
  }
  if (cred.length === 0) {
    throw new CredentialSyncerError(
      3,
      moduleErr(`Keychain entry '${keychainService}' is empty.`),
    );
  }
  try {
    JSON.parse(cred);
  } catch {
    // Do NOT include the credential bytes in the error message — the bash
    // port is explicit about this and the bats test asserts non-leakage of
    // even a malformed value.
    throw new CredentialSyncerError(
      3,
      moduleErr(
        `Keychain entry '${keychainService}' is not valid JSON. Re-login via the Claude desktop app and retry.`,
      ),
    );
  }

  // 3. Upload via SSM PutParameter. The SDK serializes the value into the
  //    request body — never argv. The Overwrite flag matches the bash port:
  //    aws-bootstrap creates the parameter with a placeholder, we overwrite
  //    it on every run. Type+KeyId need not be repeated when overwriting,
  //    but we set them so a fresh sync against a non-bootstrapped account
  //    still works (defensive — usually the operator runs bootstrap-aws
  //    first).
  info(
    moduleInfo(
      `uploading credential to ${ssmKey} (region=${region}, kms=${kmsAlias})`,
    ),
  );

  try {
    await clients.ssm.send(
      new PutParameterCommand({
        Name: ssmKey,
        Type: "SecureString",
        KeyId: kmsAlias,
        Value: cred,
        Overwrite: true,
      }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialSyncerError(
      1,
      moduleErr(`ssm put-parameter failed for ${ssmKey}: ${detail}`),
    );
  }

  info(moduleInfo(`uploaded credential to ${ssmKey}`));
}
