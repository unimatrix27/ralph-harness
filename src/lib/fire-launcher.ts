// fire-launcher — TS port of iteration-1's lib/fire-launcher.sh, slimmed
// down to match the new user-data shape (small stub installs the npm
// package and execs ralph-orchestrate, rather than bundling bash inline).
//
// Public surface:
//   run(opts) — fires one throwaway EC2 instance, polls for termination
//               with a wall-clock ceiling, runs the post-hoc agent-stuck
//               check, returns the wait-for-terminated exit code.
//   resolveLauncherConfig(env) — pure resolver, exposed for tests.
//
// Reads from env:
//   Required:
//     RALPH_TARGET_REPO
//
//   With overridable defaults (matching iteration-1 names):
//     RALPH_AWS_REGION              eu-central-1
//     RALPH_LOG_GROUP               /ralph/main
//     RALPH_GITHUB_TOKEN_SSM_KEY    /ralph/github-pat
//     RALPH_CLAUDE_OAUTH_SSM_KEY    /ralph/claude-oauth-credential
//     RALPH_INSTANCE_TYPE           m7a.xlarge
//     RALPH_ROOT_VOLUME_GB          30
//     RALPH_SG_NAME                 ralph-sg
//     RALPH_IAM_PROFILE             ralph-ec2-profile
//     RALPH_AMI_SSM_PARAM           /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
//     RALPH_MAX_LIFETIME_MIN        75
//     RALPH_POLL_INTERVAL_SEC       20
//     RALPH_AGENT_STUCK_LABEL       agent-stuck
//     RALPH_HARNESS_VERSION         <launcher's own running version>
//
// Exit codes:
//   0   instance terminated cleanly within the ceiling
//   2   missing AWS-side resource OR missing required env
//   3   wall-clock ceiling breached; force terminate-instances was issued

import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";

import {
  defaultAwsClients,
  type AwsClients,
} from "./aws-clients.js";
import { postHocCheck } from "./post-hoc-agent-stuck-checker.js";
import { renderUserData } from "./user-data-renderer.js";

export const MODULE_PREFIX = "fire-launcher";

export interface LauncherConfig {
  region: string;
  logGroup: string;
  githubTokenSsmKey: string;
  claudeOauthSsmKey: string;
  instanceType: string;
  rootVolumeGb: number;
  sgName: string;
  iamProfile: string;
  amiSsmParam: string;
  maxLifetimeMin: number;
  pollIntervalSec: number;
  agentStuckLabel: string;
  harnessVersion: string;
  targetRepo: string;
}

export const DEFAULTS = {
  region: "eu-central-1",
  logGroup: "/ralph/main",
  githubTokenSsmKey: "/ralph/github-pat",
  claudeOauthSsmKey: "/ralph/claude-oauth-credential",
  instanceType: "m7a.xlarge",
  rootVolumeGb: 30,
  sgName: "ralph-sg",
  iamProfile: "ralph-ec2-profile",
  amiSsmParam:
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  maxLifetimeMin: 75,
  pollIntervalSec: 20,
  agentStuckLabel: "agent-stuck",
} as const;

export class LauncherError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = "LauncherError";
  }
}

function moduleErr(message: string): string {
  return `${MODULE_PREFIX}: error: ${message}`;
}

function moduleInfo(message: string): string {
  return `${MODULE_PREFIX}: ${message}`;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value || value.length === 0) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// resolveLauncherConfig — pure resolver. Pulls from env with iteration-1
// names + defaults. Throws LauncherError(2) if RALPH_TARGET_REPO is missing.
// `defaultHarnessVersion` is the launcher's own running package version,
// used when RALPH_HARNESS_VERSION is unset.
export function resolveLauncherConfig(
  env: NodeJS.ProcessEnv,
  defaultHarnessVersion: string,
): LauncherConfig {
  const targetRepo = env.RALPH_TARGET_REPO ?? "";
  if (targetRepo.length === 0) {
    throw new LauncherError(
      2,
      moduleErr("RALPH_TARGET_REPO is required (e.g. owner/repo)"),
    );
  }
  return {
    region: env.RALPH_AWS_REGION || DEFAULTS.region,
    logGroup: env.RALPH_LOG_GROUP || DEFAULTS.logGroup,
    githubTokenSsmKey:
      env.RALPH_GITHUB_TOKEN_SSM_KEY || DEFAULTS.githubTokenSsmKey,
    claudeOauthSsmKey:
      env.RALPH_CLAUDE_OAUTH_SSM_KEY || DEFAULTS.claudeOauthSsmKey,
    instanceType: env.RALPH_INSTANCE_TYPE || DEFAULTS.instanceType,
    rootVolumeGb: intFromEnv(env.RALPH_ROOT_VOLUME_GB, DEFAULTS.rootVolumeGb),
    sgName: env.RALPH_SG_NAME || DEFAULTS.sgName,
    iamProfile: env.RALPH_IAM_PROFILE || DEFAULTS.iamProfile,
    amiSsmParam: env.RALPH_AMI_SSM_PARAM || DEFAULTS.amiSsmParam,
    maxLifetimeMin: intFromEnv(
      env.RALPH_MAX_LIFETIME_MIN,
      DEFAULTS.maxLifetimeMin,
    ),
    pollIntervalSec: intFromEnv(
      env.RALPH_POLL_INTERVAL_SEC,
      DEFAULTS.pollIntervalSec,
    ),
    agentStuckLabel:
      env.RALPH_AGENT_STUCK_LABEL || DEFAULTS.agentStuckLabel,
    harnessVersion:
      env.RALPH_HARNESS_VERSION && env.RALPH_HARNESS_VERSION.length > 0
        ? env.RALPH_HARNESS_VERSION
        : defaultHarnessVersion,
    targetRepo,
  };
}

// resolveDefaultVpc — locate the region's default VPC.
async function resolveDefaultVpc(clients: AwsClients): Promise<string> {
  const r = await clients.ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    }),
  );
  const id = r.Vpcs?.[0]?.VpcId;
  if (!id) throw new LauncherError(2, moduleErr("no default VPC in region"));
  return id;
}

async function resolvePublicSubnet(
  clients: AwsClients,
  vpcId: string,
): Promise<string> {
  const r = await clients.ec2.send(
    new DescribeSubnetsCommand({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "default-for-az", Values: ["true"] },
      ],
    }),
  );
  const id = r.Subnets?.[0]?.SubnetId;
  if (!id) {
    throw new LauncherError(2, moduleErr(`no default subnet in vpc ${vpcId}`));
  }
  return id;
}

async function resolveSecurityGroup(
  clients: AwsClients,
  vpcId: string,
  name: string,
): Promise<string> {
  const r = await clients.ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "group-name", Values: [name] },
      ],
    }),
  );
  const id = r.SecurityGroups?.[0]?.GroupId;
  if (!id) {
    throw new LauncherError(
      2,
      moduleErr(
        `security group ${name} not found in vpc ${vpcId}; run ralph-bootstrap-aws first`,
      ),
    );
  }
  return id;
}

async function resolveImageId(
  clients: AwsClients,
  amiSsmParam: string,
): Promise<string> {
  const r = await clients.ssm.send(
    new GetParameterCommand({ Name: amiSsmParam }),
  );
  const id = r.Parameter?.Value;
  if (!id) {
    throw new LauncherError(
      2,
      moduleErr(`could not resolve AL2023 image id from ${amiSsmParam}`),
    );
  }
  return id;
}

interface RunInstanceParams {
  config: LauncherConfig;
  imageId: string;
  subnetId: string;
  sgId: string;
  userData: string;
}

async function runInstance(
  clients: AwsClients,
  p: RunInstanceParams,
): Promise<string> {
  const userDataB64 = Buffer.from(p.userData, "utf8").toString("base64");
  const r = await clients.ec2.send(
    new RunInstancesCommand({
      ImageId: p.imageId,
      InstanceType: p.config.instanceType as never,
      // SubnetId, SecurityGroupIds, and AssociatePublicIpAddress all live
      // on the NetworkInterfaces entry. EC2 rejects mixing top-level
      // SubnetId/SecurityGroupIds with a NetworkInterfaces block.
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: p.subnetId,
          Groups: [p.sgId],
          AssociatePublicIpAddress: true,
        },
      ],
      IamInstanceProfile: { Name: p.config.iamProfile },
      InstanceInitiatedShutdownBehavior: "terminate",
      UserData: userDataB64,
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/xvda",
          Ebs: {
            VolumeSize: p.config.rootVolumeGb,
            VolumeType: "gp3",
            DeleteOnTermination: true,
          },
        },
      ],
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Project", Value: "ralph" },
            { Key: "Name", Value: "ralph-harness" },
            { Key: "LaunchedAt", Value: new Date().toISOString() },
            {
              Key: "MaxLifetimeMin",
              Value: String(p.config.maxLifetimeMin),
            },
          ],
        },
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Project", Value: "ralph" },
            { Key: "LaunchedAt", Value: new Date().toISOString() },
            {
              Key: "MaxLifetimeMin",
              Value: String(p.config.maxLifetimeMin),
            },
          ],
        },
      ],
      MetadataOptions: {
        HttpTokens: "required",
        HttpEndpoint: "enabled",
        HttpPutResponseHopLimit: 2,
      },
      MinCount: 1,
      MaxCount: 1,
    }),
  );
  const inst = r.Instances?.[0]?.InstanceId;
  if (!inst) {
    throw new LauncherError(
      1,
      moduleErr("run-instances did not return an instance id"),
    );
  }
  return inst;
}

// Sleep helper used by waitForTerminated. Exposed for test injection.
export type Sleeper = (ms: number) => Promise<void>;
const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

export type Clock = () => number; // ms since epoch
const realNow: Clock = () => Date.now();

interface WaitOptions {
  config: LauncherConfig;
  instanceId: string;
  info: (line: string) => void;
  now?: Clock;
  sleep?: Sleeper;
}

// detectEarlyExit — issue #37 backstop. Looks at the per-instance
// CloudWatch stream for sentinel lines that prove the orchestrator is
// done (`ORCHESTRATOR_EXITED rc=N`) or has reached a terminal outcome
// (`OUTCOME=...`). The trap-shutdown in user-data is the primary
// mechanism; this check covers the case where the orchestrator process
// itself was killed (OOM, signal) before its trap could fire. Returns
// the matching log line on hit, null otherwise. Any read failure is
// treated as "no signal" — callers fall back to the describe-instances
// poll + wall-clock ceiling.
export async function detectEarlyExit(
  clients: AwsClients,
  logGroup: string,
  instanceId: string,
): Promise<string | null> {
  try {
    const r = await clients.logs.send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        logStreamNames: [instanceId],
        // Match either marker. The CloudWatch filter pattern grammar uses
        // ?-prefixed terms for OR; quoted string literals match anywhere
        // in the message.
        filterPattern: '?"ORCHESTRATOR_EXITED rc=" ?"OUTCOME="',
      }),
    );
    for (const ev of r.events ?? []) {
      const msg = (ev.message ?? "").trim();
      if (
        msg.includes("ORCHESTRATOR_EXITED rc=") ||
        msg.includes("OUTCOME=")
      ) {
        return msg;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// waitForTerminated — polls describe-instances until State.Name=terminated.
// Returns 0 on clean termination, 3 on wall-clock ceiling breach (after
// firing terminate-instances on best-effort).
//
// Each tick also checks CloudWatch for an early-exit sentinel (issue
// #37). On hit, terminate-instances is fired immediately and the
// describe-instances loop continues until the state actually flips to
// `terminated` — that way callers always see a real terminal state and
// the post-hoc checker still has time to read the stream.
export async function waitForTerminated(
  clients: AwsClients,
  opts: WaitOptions,
): Promise<number> {
  const now = opts.now ?? realNow;
  const sleep = opts.sleep ?? realSleep;
  const deadline = now() + opts.config.maxLifetimeMin * 60_000;
  let earlyExitForced = false;
  for (;;) {
    let state = "";
    try {
      const r = await clients.ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [opts.instanceId] }),
      );
      state = r.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "";
    } catch {
      state = "";
    }
    if (state === "terminated") {
      opts.info(moduleInfo(`instance ${opts.instanceId} terminated`));
      return 0;
    }
    if (state.length === 0) {
      opts.info(
        moduleInfo(`could not read state for ${opts.instanceId}; retrying`),
      );
    } else {
      opts.info(
        moduleInfo(`instance ${opts.instanceId} state=${state}`),
      );
    }
    // CloudWatch backstop — only fire terminate-instances once. Once the
    // describe-instances loop sees the resulting `terminated` state we
    // exit cleanly.
    if (!earlyExitForced) {
      const marker = await detectEarlyExit(
        clients,
        opts.config.logGroup,
        opts.instanceId,
      );
      if (marker !== null) {
        opts.info(
          moduleInfo(
            `early-exit signal observed in CloudWatch: ${marker}; forcing terminate`,
          ),
        );
        try {
          await clients.ec2.send(
            new TerminateInstancesCommand({ InstanceIds: [opts.instanceId] }),
          );
        } catch {
          // best-effort
        }
        earlyExitForced = true;
      }
    }
    if (now() >= deadline) {
      opts.info(
        `${MODULE_PREFIX}: error: wall-clock ceiling (${opts.config.maxLifetimeMin}m) breached; forcing terminate`,
      );
      try {
        await clients.ec2.send(
          new TerminateInstancesCommand({ InstanceIds: [opts.instanceId] }),
        );
      } catch {
        // best-effort — propagate the ceiling breach as the rc anyway
      }
      return 3;
    }
    await sleep(opts.config.pollIntervalSec * 1_000);
  }
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  // The launcher's own running version, used when RALPH_HARNESS_VERSION is
  // unset (every consumer should pass this from their `package.json`).
  defaultHarnessVersion: string;
  clients?: AwsClients;
  info?: (line: string) => void;
  // Optional override for the user-data string. When set the renderer is
  // skipped entirely. Used by integration smoke tests.
  userDataOverride?: string;
  // Hooks for testing.
  now?: Clock;
  sleep?: Sleeper;
}

const stdoutInfo = (line: string) => process.stdout.write(`${line}\n`);

// run — full launch path. Returns the wait_for_terminated exit code (0 or 3).
// On any pre-launch failure, throws LauncherError with the matching exit code.
export async function run(opts: RunOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const info = opts.info ?? stdoutInfo;
  const config = resolveLauncherConfig(env, opts.defaultHarnessVersion);
  const clients = opts.clients ?? defaultAwsClients(config.region);

  const vpcId = await resolveDefaultVpc(clients);
  const subnetId = await resolvePublicSubnet(clients, vpcId);
  const sgId = await resolveSecurityGroup(clients, vpcId, config.sgName);
  const imageId = await resolveImageId(clients, config.amiSsmParam);

  info(
    moduleInfo(
      `region=${config.region} vpc=${vpcId} subnet=${subnetId} sg=${sgId} ami=${imageId}`,
    ),
  );
  info(
    moduleInfo(
      `instance_type=${config.instanceType} root_gb=${config.rootVolumeGb} max_lifetime_min=${config.maxLifetimeMin}`,
    ),
  );
  info(
    moduleInfo(
      `target=${config.targetRepo} log_group=${config.logGroup} version=${config.harnessVersion}`,
    ),
  );

  const userData =
    opts.userDataOverride ??
    renderUserData({
      targetRepo: config.targetRepo,
      harnessVersion: config.harnessVersion,
      awsRegion: config.region,
      logGroup: config.logGroup,
      githubTokenSsmKey: config.githubTokenSsmKey,
      claudeOauthSsmKey: config.claudeOauthSsmKey,
      agentStuckLabel: config.agentStuckLabel,
      extraEnv:
        env.RALPH_DEBUG_TRANSCRIPT === "1"
          ? { RALPH_DEBUG_TRANSCRIPT: "1" }
          : undefined,
    });
  info(
    moduleInfo(
      `user-data size: ${Buffer.byteLength(userData, "utf8")} bytes (cap=16384)`,
    ),
  );

  const instanceId = await runInstance(clients, {
    config,
    imageId,
    subnetId,
    sgId,
    userData,
  });
  info(moduleInfo(`launched ${instanceId}`));
  info(
    moduleInfo(
      `log_group=${config.logGroup} log_stream=${instanceId}`,
    ),
  );
  info(
    moduleInfo(
      `tail with: aws --region ${config.region} logs tail ${config.logGroup} --log-stream-names ${instanceId} --follow`,
    ),
  );

  const waitRc = await waitForTerminated(clients, {
    config,
    instanceId,
    info,
    now: opts.now,
    sleep: opts.sleep,
  });

  // Post-hoc agent-stuck check. Runs unconditionally so a wall-clock
  // breach (rc=3) still gets the post-hoc correlation.
  await postHocCheck({
    clients,
    targetRepo: config.targetRepo,
    launchTag: instanceId,
    instanceId,
    logGroup: config.logGroup,
    agentStuckLabel: config.agentStuckLabel,
    info,
  });

  return waitRc;
}
