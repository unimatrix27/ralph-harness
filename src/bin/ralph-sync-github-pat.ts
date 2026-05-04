#!/usr/bin/env node
//
// ralph-sync-github-pat — write a GitHub PAT into the SSM SecureString that
// the EC2 worker reads at launch. Net-new in slice 4 (the iteration-1 fire
// path bootstrapped a placeholder via aws-bootstrap and the operator
// overwrote it manually with `aws ssm put-parameter`).
//
// Usage:
//   echo $TOKEN | ralph-sync-github-pat
//   ralph-sync-github-pat < ./token.txt
//
// The token must be supplied on stdin. We deliberately do NOT accept the
// token on argv (it would land in shell history + ps output). We also do
// not read from a $RALPH_GITHUB_PAT env var — env vars on macOS leak into
// process listings.
//
// Reads from env:
//   RALPH_GITHUB_TOKEN_SSM_KEY    SSM parameter name
//                                 (default /ralph/github-pat)
//
// Region is forced to eu-central-1.
//
// Exit codes:
//   0   success
//   2   usage error (no stdin / empty input / argv given)
//   4   AWS credentials not configured
//   1   any other failure

import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { AWS_REGION, defaultAwsClients } from "../lib/aws-clients.js";

const MODULE_PREFIX = "github-pat-syncer";
const DEFAULT_SSM_KEY = "/ralph/github-pat";
const DEFAULT_KMS_ALIAS = "alias/ralph";

function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

function moduleInfo(message: string): string {
  return `${MODULE_PREFIX}: ${message}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.stderr.write(
      moduleErr(
        "this CLI takes no arguments — pass the token on stdin (echo $TOKEN | ralph-sync-github-pat)",
      ) + "\n",
    );
    process.exit(2);
  }

  if (process.stdin.isTTY) {
    process.stderr.write(
      moduleErr(
        "no stdin attached. Pipe the token in: 'echo $TOKEN | ralph-sync-github-pat' (or redirect from a file).",
      ) + "\n",
    );
    process.exit(2);
  }

  const ssmKey =
    process.env.RALPH_GITHUB_TOKEN_SSM_KEY || DEFAULT_SSM_KEY;
  const kmsAlias = DEFAULT_KMS_ALIAS;

  const raw = await readStdin();
  // Strip exactly one trailing newline (added by `echo`/`cat`); preserve
  // whitespace inside the token. If the operator typed multiple lines we
  // keep them — the SDK will reject anything that isn't a valid GitHub PAT
  // when it's actually used downstream.
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (token.length === 0) {
    process.stderr.write(moduleErr("stdin was empty.") + "\n");
    process.exit(2);
  }

  const clients = defaultAwsClients();

  try {
    await clients.sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      moduleErr(
        `AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE. (${detail})`,
      ) + "\n",
    );
    process.exit(4);
  }

  process.stdout.write(
    moduleInfo(
      `uploading PAT to ${ssmKey} (region=${AWS_REGION}, kms=${kmsAlias})`,
    ) + "\n",
  );

  await clients.ssm.send(
    new PutParameterCommand({
      Name: ssmKey,
      Type: "SecureString",
      KeyId: kmsAlias,
      Value: token,
      Overwrite: true,
    }),
  );

  process.stdout.write(moduleInfo(`uploaded PAT to ${ssmKey}`) + "\n");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
