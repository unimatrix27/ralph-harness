#!/usr/bin/env node
//
// ralph-bootstrap-aws — idempotent first-run bootstrap of the AWS-side and
// target-side resources the ralph-harness needs. Drop-in replacement for
// the (deleted) bin/bootstrap-aws.sh.
//
// Usage:
//   ralph-bootstrap-aws
//
// Reads from env:
//   RALPH_TARGET_REPO              required (owner/repo)
//   RALPH_GITHUB_TOKEN_SSM_KEY     defaults to /ralph/github-pat
//   RALPH_CLAUDE_OAUTH_SSM_KEY     defaults to /ralph/claude-oauth-credential
//   RALPH_LOG_GROUP                defaults to /ralph/main
//
// Region is forced to eu-central-1 (matches lib/aws-clients.ts AWS_REGION).
//
// Re-running on an already-bootstrapped account is a clean no-op.
//
// Exit codes (matching bin/bootstrap-aws.sh):
//   0   success
//   2   usage / missing required env var
//   non-zero   propagated from underlying SDK / gh failure

import { DEFAULTS, moduleErr, runAll } from "../lib/aws-bootstrap.js";
import { defaultAwsClients } from "../lib/aws-clients.js";

async function main(): Promise<void> {
  const repo = process.env.RALPH_TARGET_REPO;
  if (!repo || repo.length === 0) {
    process.stderr.write(
      moduleErr("RALPH_TARGET_REPO is required (e.g. owner/repo)") + "\n",
    );
    process.exit(2);
  }

  const githubKey =
    process.env.RALPH_GITHUB_TOKEN_SSM_KEY || DEFAULTS.githubKey;
  const oauthKey =
    process.env.RALPH_CLAUDE_OAUTH_SSM_KEY || DEFAULTS.oauthKey;
  const logGroup = process.env.RALPH_LOG_GROUP || DEFAULTS.logGroup;

  const clients = defaultAwsClients();
  await runAll({ clients, repo, githubKey, oauthKey, logGroup });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
