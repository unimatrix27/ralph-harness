// aws-bootstrap — idempotent AWS-side and target-side bootstrap for the
// ralph-harness operator. Public functions ensure each resource exists;
// re-running on an already-bootstrapped account is a clean no-op.
//
// Public surface:
//   ensureKmsAlias(clients, alias)
//   ensureSsmSecureString(clients, name, description, kmsAlias)
//   ensureIamRoleAndProfile(clients, role, profile, githubKey, oauthKey, logGroup, kmsAlias)
//   ensureSecurityGroup(clients, name, description)
//   ensureLogGroup(clients, name)
//   ensureAgentStuckLabel(repo, label)
//   runAll(opts)
//
// Idempotency contract (must match lib/aws-bootstrap.sh — bash module is
// being deleted in this slice; the contract is what's tested):
//   Every ensure* function probes for the resource's current state and only
//   issues create/put calls when state is missing. On second run the only
//   AWS calls made are read-only describe/get operations.
//
// Errors throw; the CLI (ralph-bootstrap-aws) maps them to exit codes.

import {
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
} from "@aws-sdk/client-ec2";
import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  GetInstanceProfileCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
} from "@aws-sdk/client-kms";
import {
  GetParameterCommand,
  ParameterAlreadyExists,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { AWS_REGION, type AwsClients } from "./aws-clients.js";
import { GhRunnerError, runGh } from "./gh-runner.js";

export const MODULE_PREFIX = "aws-bootstrap";

export const DEFAULTS = {
  region: AWS_REGION,
  kmsAlias: "alias/ralph",
  iamRole: "ralph-ec2-role",
  iamProfile: "ralph-ec2-profile",
  sgName: "ralph-sg",
  agentStuckLabel: "agent-stuck",
  agentStuckColor: "d73a4a",
  githubKey: "/ralph/github-pat",
  oauthKey: "/ralph/claude-oauth-credential",
  logGroup: "/ralph/main",
} as const;

export function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

export function moduleInfo(message: string): string {
  return `${MODULE_PREFIX}: ${message}`;
}

export type Logger = (line: string) => void;

const defaultInfo: Logger = (line) => process.stdout.write(`${line}\n`);

// ---- KMS -------------------------------------------------------------

// ensureKmsAlias — ensure a KMS CMK exists behind the given alias. If the
// alias resolves, no-op. Otherwise create a symmetric encrypt/decrypt key
// and point the alias at it.
export async function ensureKmsAlias(
  clients: AwsClients,
  alias: string,
  info: Logger = defaultInfo,
): Promise<void> {
  try {
    await clients.kms.send(new DescribeKeyCommand({ KeyId: alias }));
    info(moduleInfo(`kms: ${alias} already exists`));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const created = await clients.kms.send(
    new CreateKeyCommand({
      Description: `ralph-harness CMK (used by ${alias})`,
      KeyUsage: "ENCRYPT_DECRYPT",
    }),
  );
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyId) {
    throw new Error(moduleErr(`kms: create-key returned no KeyId`));
  }

  await clients.kms.send(
    new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyId }),
  );
  info(moduleInfo(`kms: created ${alias} -> ${keyId}`));
}

// ---- SSM SecureString -----------------------------------------------

const SSM_PLACEHOLDER = "PLACEHOLDER-set-via-credential-syncer";

// ensureSsmSecureString — ensure a SecureString parameter exists at <name>.
// If missing, create it with a placeholder. If present, leave it untouched
// (we never overwrite an existing parameter).
export async function ensureSsmSecureString(
  clients: AwsClients,
  name: string,
  description: string,
  kmsAlias: string,
  info: Logger = defaultInfo,
): Promise<void> {
  try {
    await clients.ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    info(moduleInfo(`ssm: ${name} already exists`));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  try {
    await clients.ssm.send(
      new PutParameterCommand({
        Name: name,
        Description: description,
        Type: "SecureString",
        KeyId: kmsAlias,
        Value: SSM_PLACEHOLDER,
        Overwrite: false,
      }),
    );
  } catch (err) {
    // Race: another caller created it between our get and put. Treat the
    // already-exists error as success — the post-condition is "parameter
    // exists with some value", which is satisfied either way.
    if (err instanceof ParameterAlreadyExists) {
      info(moduleInfo(`ssm: ${name} already exists (raced put)`));
      return;
    }
    throw err;
  }
  info(moduleInfo(`ssm: created ${name}`));
}

// ---- IAM role + instance profile ------------------------------------

interface PolicyDoc {
  Version: string;
  Statement: PolicyStatement[];
}

interface PolicyStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string[] | string;
  Condition?: unknown;
}

const TRUST_POLICY: PolicyDoc = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "EC2AssumeRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      // The IAM service ignores Sid uniqueness in trust docs; this is just
      // the canonical shape. Kept as a literal so the JSON we send is stable.
      Resource: "ec2.amazonaws.com",
    },
  ],
} as unknown as PolicyDoc;

// The bash port emits the trust policy in a slightly different shape (single
// Principal:Service statement). The IAM API requires that exact shape, so we
// emit raw JSON for the trust policy rather than reusing the inline-policy
// builder.
const TRUST_POLICY_DOC_JSON = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

export function buildInlinePolicy(
  account: string,
  githubKey: string,
  oauthKey: string,
  logGroup: string,
  kmsAlias: string,
  region: string = DEFAULTS.region,
): PolicyDoc {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadAssignedSSMParameters",
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Resource: [
          `arn:aws:ssm:${region}:${account}:parameter${githubKey}`,
          `arn:aws:ssm:${region}:${account}:parameter${oauthKey}`,
        ],
      },
      {
        Sid: "DecryptRalphKMS",
        Effect: "Allow",
        Action: ["kms:Decrypt"],
        Resource: "*",
        Condition: {
          "ForAnyValue:StringEquals": { "kms:ResourceAliases": kmsAlias },
        },
      },
      {
        Sid: "PutRalphLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ],
        Resource: `arn:aws:logs:${region}:${account}:log-group:${logGroup}:*`,
      },
    ],
  };
}

// canonicalJson — stable key-sorted JSON. Used to compare an existing inline
// policy against the desired one without false-diffing on key order.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k]);
    }
    return out;
  }
  return value;
}

// ensureIamRoleAndProfile — ensure the EC2 role exists with the EC2 trust
// policy, AmazonSSMManagedInstanceCore attached, and the inline policy
// `ralph-inline` granting:
//   - SSM read on the two assigned parameter keys
//   - kms:Decrypt scoped to <kmsAlias>
//   - PutLogEvents scoped to <logGroup>
// Plus: the instance profile exists and the role is attached to it.
export async function ensureIamRoleAndProfile(
  clients: AwsClients,
  role: string,
  profile: string,
  githubKey: string,
  oauthKey: string,
  logGroup: string,
  kmsAlias: string,
  info: Logger = defaultInfo,
  region: string = DEFAULTS.region,
): Promise<void> {
  const account = await getAccountId(clients);
  const inlineDoc = buildInlinePolicy(
    account,
    githubKey,
    oauthKey,
    logGroup,
    kmsAlias,
    region,
  );

  // role
  let roleExists = false;
  try {
    await clients.iam.send(new GetRoleCommand({ RoleName: role }));
    roleExists = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (roleExists) {
    info(moduleInfo(`iam: role ${role} already exists`));
  } else {
    await clients.iam.send(
      new CreateRoleCommand({
        RoleName: role,
        Description: "ralph-harness EC2 worker role",
        AssumeRolePolicyDocument: TRUST_POLICY_DOC_JSON,
      }),
    );
    info(moduleInfo(`iam: created role ${role}`));
  }

  // managed policy attach
  const attached = await clients.iam.send(
    new ListAttachedRolePoliciesCommand({ RoleName: role }),
  );
  const ssmManaged = (attached.AttachedPolicies ?? []).some(
    (p) => p.PolicyName === "AmazonSSMManagedInstanceCore",
  );
  if (ssmManaged) {
    info(
      moduleInfo(
        `iam: AmazonSSMManagedInstanceCore already attached to ${role}`,
      ),
    );
  } else {
    await clients.iam.send(
      new AttachRolePolicyCommand({
        RoleName: role,
        PolicyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      }),
    );
    info(moduleInfo(`iam: attached AmazonSSMManagedInstanceCore to ${role}`));
  }

  // inline policy
  let existingInlineRaw: string | undefined;
  try {
    const got = await clients.iam.send(
      new GetRolePolicyCommand({
        RoleName: role,
        PolicyName: "ralph-inline",
      }),
    );
    // GetRolePolicy returns the document URL-encoded in the bash CLI; the
    // SDK decodes it for us into a JSON string.
    existingInlineRaw = got.PolicyDocument;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const desiredCompact = canonicalJson(inlineDoc);
  let existingCompact = "";
  if (existingInlineRaw) {
    try {
      existingCompact = canonicalJson(
        JSON.parse(decodeURIComponent(existingInlineRaw)),
      );
    } catch {
      // The SDK may already return a decoded JSON string. Try parse-as-is.
      try {
        existingCompact = canonicalJson(JSON.parse(existingInlineRaw));
      } catch {
        existingCompact = "";
      }
    }
  }
  if (existingCompact === desiredCompact) {
    info(
      moduleInfo(
        `iam: inline policy ralph-inline already up to date on ${role}`,
      ),
    );
  } else {
    await clients.iam.send(
      new PutRolePolicyCommand({
        RoleName: role,
        PolicyName: "ralph-inline",
        PolicyDocument: JSON.stringify(inlineDoc),
      }),
    );
    info(moduleInfo(`iam: wrote inline policy ralph-inline on ${role}`));
  }

  // instance profile
  let profileExists = false;
  let profileHasRole = false;
  try {
    const got = await clients.iam.send(
      new GetInstanceProfileCommand({ InstanceProfileName: profile }),
    );
    profileExists = true;
    profileHasRole = (got.InstanceProfile?.Roles ?? []).some(
      (r) => r.RoleName === role,
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (profileExists) {
    info(moduleInfo(`iam: instance profile ${profile} already exists`));
  } else {
    await clients.iam.send(
      new CreateInstanceProfileCommand({ InstanceProfileName: profile }),
    );
    info(moduleInfo(`iam: created instance profile ${profile}`));
  }

  if (profileHasRole) {
    info(
      moduleInfo(`iam: role ${role} already attached to profile ${profile}`),
    );
  } else {
    await clients.iam.send(
      new AddRoleToInstanceProfileCommand({
        InstanceProfileName: profile,
        RoleName: role,
      }),
    );
    info(moduleInfo(`iam: attached role ${role} to profile ${profile}`));
  }
}

// ---- EC2 security group ---------------------------------------------

// ensureSecurityGroup — ensure a security group named <name> exists in the
// region's default VPC. Newly-created groups inherit the default
// "no inbound, all outbound" posture, which is what the harness wants.
export async function ensureSecurityGroup(
  clients: AwsClients,
  name: string,
  description: string,
  info: Logger = defaultInfo,
  region: string = DEFAULTS.region,
): Promise<void> {
  const vpcs = await clients.ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    }),
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error(
      moduleErr(
        `no default VPC in region ${region}; refusing to create security group`,
      ),
    );
  }

  const existing = await clients.ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [name] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  const existingId = existing.SecurityGroups?.[0]?.GroupId;
  if (existingId) {
    info(
      moduleInfo(`ec2: security group ${name} already exists (${existingId})`),
    );
    return;
  }

  const created = await clients.ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: name,
      Description: description,
      VpcId: vpcId,
    }),
  );
  info(
    moduleInfo(`ec2: created security group ${name} (${created.GroupId})`),
  );
}

// ---- CloudWatch log group -------------------------------------------

// ensureLogGroup — ensure a CloudWatch log group named <name> exists.
export async function ensureLogGroup(
  clients: AwsClients,
  name: string,
  info: Logger = defaultInfo,
): Promise<void> {
  const list = await clients.logs.send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: name }),
  );
  const found = (list.logGroups ?? []).some((g) => g.logGroupName === name);
  if (found) {
    info(moduleInfo(`logs: log group ${name} already exists`));
    return;
  }
  await clients.logs.send(new CreateLogGroupCommand({ logGroupName: name }));
  info(moduleInfo(`logs: created log group ${name}`));
}

// ---- target-side gh label -------------------------------------------

// ensureAgentStuckLabel — ensure the target repo has the configured stuck
// label (red). Uses `gh label`, not the AWS SDK.
export function ensureAgentStuckLabel(
  repo: string,
  label: string,
  info: Logger = defaultInfo,
  color: string = DEFAULTS.agentStuckColor,
): void {
  let existing: string[] = [];
  try {
    const r = runGh([
      "label",
      "list",
      "--repo",
      repo,
      "--json",
      "name",
      "--jq",
      ".[].name",
    ]);
    existing = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    // gh exits non-zero only on a real failure (auth missing, repo not
    // found). Surface that — listing labels is a precondition.
    throw err instanceof GhRunnerError
      ? new Error(moduleErr(`label list ${repo} failed: ${err.message}`))
      : err;
  }
  if (existing.includes(label)) {
    info(moduleInfo(`github: label ${label} already exists on ${repo}`));
    return;
  }
  runGh([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    color,
    "--description",
    "Set by ralph-harness when an iteration escapes via the stuck-budget path.",
  ]);
  info(moduleInfo(`github: created label ${label} on ${repo}`));
}

// ---- run all --------------------------------------------------------

export interface RunAllOptions {
  clients: AwsClients;
  repo: string;
  githubKey?: string;
  oauthKey?: string;
  logGroup?: string;
  kmsAlias?: string;
  iamRole?: string;
  iamProfile?: string;
  sgName?: string;
  agentStuckLabel?: string;
  region?: string;
  info?: Logger;
}

// runAll — ensure every resource. Idempotent on second run.
export async function runAll(opts: RunAllOptions): Promise<void> {
  const {
    clients,
    repo,
    githubKey = DEFAULTS.githubKey,
    oauthKey = DEFAULTS.oauthKey,
    logGroup = DEFAULTS.logGroup,
    kmsAlias = DEFAULTS.kmsAlias,
    iamRole = DEFAULTS.iamRole,
    iamProfile = DEFAULTS.iamProfile,
    sgName = DEFAULTS.sgName,
    agentStuckLabel = DEFAULTS.agentStuckLabel,
    region = DEFAULTS.region,
    info = defaultInfo,
  } = opts;

  info(moduleInfo(`region=${region} target=${repo}`));
  info(
    moduleInfo(
      `github_key=${githubKey} oauth_key=${oauthKey} log_group=${logGroup}`,
    ),
  );

  await ensureKmsAlias(clients, kmsAlias, info);
  await ensureSsmSecureString(
    clients,
    githubKey,
    "ralph-harness GitHub PAT (SecureString placeholder)",
    kmsAlias,
    info,
  );
  await ensureSsmSecureString(
    clients,
    oauthKey,
    "ralph-harness Claude OAuth credential (SecureString placeholder)",
    kmsAlias,
    info,
  );
  await ensureLogGroup(clients, logGroup, info);
  await ensureIamRoleAndProfile(
    clients,
    iamRole,
    iamProfile,
    githubKey,
    oauthKey,
    logGroup,
    kmsAlias,
    info,
    region,
  );
  await ensureSecurityGroup(
    clients,
    sgName,
    "ralph-harness EC2 worker (no inbound, all outbound)",
    info,
    region,
  );
  ensureAgentStuckLabel(repo, agentStuckLabel, info);
}

// ---- helpers --------------------------------------------------------

async function getAccountId(clients: AwsClients): Promise<string> {
  const r = await clients.sts.send(new GetCallerIdentityCommand({}));
  if (!r.Account) {
    throw new Error(moduleErr("sts: GetCallerIdentity returned no Account"));
  }
  return r.Account;
}

// isNotFound — recognize "resource doesn't exist" errors from the AWS SDK
// across services. Each service has its own typed exception, but they all
// share the `name` property convention.
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? e.Code ?? "";
  if (
    name === "NotFoundException" ||
    name === "NoSuchEntityException" ||
    name === "ParameterNotFound" ||
    name === "ResourceNotFoundException" ||
    name === "ResourceNotFoundFault" ||
    name === "NotFound" ||
    name === "InvalidGroup.NotFound"
  ) {
    return true;
  }
  // Some errors only carry the httpStatusCode — IAM GetRole returns 404 with
  // name=NoSuchEntityException already, but be defensive.
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}
