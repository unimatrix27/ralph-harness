#!/usr/bin/env node
//
// ralph-sync-credential — extract the macOS Keychain `Claude Code-credentials`
// entry and write it into SSM as a SecureString. Drop-in replacement for the
// (deleted) bin/sync-credential.sh. Re-run after every desktop `claude /login`.
//
// Usage:
//   ralph-sync-credential [<ssm-key>]
//
// Reads from env:
//   RALPH_CLAUDE_OAUTH_SSM_KEY    SSM parameter name
//                                 (default /ralph/claude-oauth-credential)
//
// Region is forced to eu-central-1. The credential is never echoed, logged,
// or placed on any process's argv.
//
// Exit codes (matching bin/sync-credential.sh + lib/credential-syncer.sh):
//   0   success
//   2   usage error
//   3   Keychain entry missing, empty, or not JSON
//   4   AWS credentials not configured
//   1   any other failure

import { defaultAwsClients } from "../lib/aws-clients.js";
import {
  CredentialSyncerError,
  DEFAULTS,
  moduleErr,
  syncCredential,
} from "../lib/credential-syncer.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    process.stderr.write(
      moduleErr("usage: ralph-sync-credential [<ssm-key>]") + "\n",
    );
    process.exit(2);
  }
  const ssmKey =
    args[0] ?? process.env.RALPH_CLAUDE_OAUTH_SSM_KEY ?? DEFAULTS.ssmKey;

  const clients = defaultAwsClients();
  await syncCredential({ clients, ssmKey });
}

main().catch((err) => {
  if (err instanceof CredentialSyncerError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
