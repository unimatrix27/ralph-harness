// Unit tests for aws-bootstrap. Mocks the AWS SDK clients via a `send()`
// stub keyed on the command class name; asserts on the canned-reply matrix
// rather than wire calls (the SDK is the boundary the bash bats tests
// stubbed at the `aws` CLI; here we stub one level higher).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh-runner.js", () => {
  const calls: { args: string[] }[] = [];
  let nextStdoutQueue: string[] = [];
  let nextThrowQueue: (Error | undefined)[] = [];

  function runGh(args: readonly string[]) {
    calls.push({ args: [...args] });
    const err = nextThrowQueue.shift();
    if (err) throw err;
    const stdout = nextStdoutQueue.shift() ?? "";
    return { stdout, stderr: "", exitCode: 0 };
  }

  function __reset() {
    calls.length = 0;
    nextStdoutQueue = [];
    nextThrowQueue = [];
  }
  function __queueStdout(...outputs: string[]) {
    nextStdoutQueue.push(...outputs);
  }
  function __calls() {
    return calls;
  }

  class GhRunnerError extends Error {
    constructor(
      public readonly exitCode: number,
      public readonly stderr: string,
      message: string,
    ) {
      super(message);
      this.name = "GhRunnerError";
    }
  }

  return {
    runGh,
    runGhJson: () => {
      throw new Error("not used here");
    },
    GhRunnerError,
    __reset,
    __queueStdout,
    __calls,
  };
});

import {
  buildInlinePolicy,
  canonicalJson,
  ensureAgentStuckLabel,
  ensureIamRoleAndProfile,
  ensureKmsAlias,
  ensureLogGroup,
  ensureSecurityGroup,
  ensureSsmSecureString,
  runAll,
} from "./aws-bootstrap.js";
import type { AwsClients } from "./aws-clients.js";

const ghRunner = (await import("./gh-runner.js")) as unknown as {
  __reset: () => void;
  __queueStdout: (...s: string[]) => void;
  __calls: () => { args: string[] }[];
};

// ---- mock client factory ----

interface FakeClient {
  send: ReturnType<typeof vi.fn>;
}

interface NotFoundOpts {
  name?: string;
}

function notFound(opts: NotFoundOpts = {}): Error {
  const e = new Error(opts.name ?? "NoSuchEntityException") as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  e.name = opts.name ?? "NoSuchEntityException";
  e.$metadata = { httpStatusCode: 404 };
  return e;
}

// dispatchMock — given a map keyed on command-class name, return a `send`
// fn that consumes the next entry in the matching queue (so multiple calls
// to the same command produce a sequence of replies).
function dispatchMock(
  table: Record<string, Array<unknown | (() => unknown)>>,
): ReturnType<typeof vi.fn> {
  const queues: Record<string, Array<unknown | (() => unknown)>> = {};
  for (const k of Object.keys(table)) queues[k] = [...table[k]!];
  return vi.fn(async (cmd: { constructor: { name: string } }) => {
    const key = cmd.constructor.name;
    const queue = queues[key];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected ${key} call`);
    }
    const next = queue.shift()!;
    const value = typeof next === "function" ? (next as () => unknown)() : next;
    if (value instanceof Error) throw value;
    return value as unknown;
  });
}

function fakeClients(table: {
  kms?: Record<string, unknown[]>;
  ssm?: Record<string, unknown[]>;
  iam?: Record<string, unknown[]>;
  ec2?: Record<string, unknown[]>;
  logs?: Record<string, unknown[]>;
  sts?: Record<string, unknown[]>;
}): AwsClients {
  const c = {} as Record<keyof AwsClients, FakeClient>;
  for (const svc of ["kms", "ssm", "iam", "ec2", "logs", "sts"] as const) {
    c[svc] = { send: dispatchMock(table[svc] ?? {}) };
  }
  return c as unknown as AwsClients;
}

const noop = (): void => {};

beforeEach(() => {
  ghRunner.__reset();
});

afterEach(() => {
  ghRunner.__reset();
});

// ---- ensureKmsAlias ----

describe("ensureKmsAlias", () => {
  it("creates key + alias on first run", async () => {
    const clients = fakeClients({
      kms: {
        DescribeKeyCommand: [notFound({ name: "NotFoundException" })],
        CreateKeyCommand: [{ KeyMetadata: { KeyId: "abcd-1234" } }],
        CreateAliasCommand: [{}],
      },
    });
    await ensureKmsAlias(clients, "alias/ralph", noop);
    expect((clients.kms as unknown as FakeClient).send).toHaveBeenCalledTimes(3);
  });

  it("skips creation when alias resolves", async () => {
    const clients = fakeClients({
      kms: {
        DescribeKeyCommand: [{ KeyMetadata: { KeyId: "abcd" } }],
      },
    });
    await ensureKmsAlias(clients, "alias/ralph", noop);
    expect((clients.kms as unknown as FakeClient).send).toHaveBeenCalledTimes(1);
  });
});

// ---- ensureSsmSecureString ----

describe("ensureSsmSecureString", () => {
  it("puts SecureString placeholder on first run", async () => {
    const clients = fakeClients({
      ssm: {
        GetParameterCommand: [notFound({ name: "ParameterNotFound" })],
        PutParameterCommand: [{}],
      },
    });
    await ensureSsmSecureString(
      clients,
      "/ralph/github-pat",
      "desc",
      "alias/ralph",
      noop,
    );
    const ssm = clients.ssm as unknown as FakeClient;
    expect(ssm.send).toHaveBeenCalledTimes(2);
    const putCall = ssm.send.mock.calls[1]![0] as {
      input: { Type: string; KeyId: string; Overwrite: boolean };
    };
    expect(putCall.input.Type).toBe("SecureString");
    expect(putCall.input.KeyId).toBe("alias/ralph");
    expect(putCall.input.Overwrite).toBe(false);
  });

  it("skips put when parameter already exists", async () => {
    const clients = fakeClients({
      ssm: {
        GetParameterCommand: [{ Parameter: { Name: "/ralph/github-pat" } }],
      },
    });
    await ensureSsmSecureString(
      clients,
      "/ralph/github-pat",
      "desc",
      "alias/ralph",
      noop,
    );
    expect((clients.ssm as unknown as FakeClient).send).toHaveBeenCalledTimes(
      1,
    );
  });
});

// ---- ensureLogGroup ----

describe("ensureLogGroup", () => {
  it("creates when missing", async () => {
    const clients = fakeClients({
      logs: {
        DescribeLogGroupsCommand: [{ logGroups: [] }],
        CreateLogGroupCommand: [{}],
      },
    });
    await ensureLogGroup(clients, "/ralph/main", noop);
    expect((clients.logs as unknown as FakeClient).send).toHaveBeenCalledTimes(
      2,
    );
  });

  it("skips when log group already present (exact-name match)", async () => {
    const clients = fakeClients({
      logs: {
        DescribeLogGroupsCommand: [
          {
            logGroups: [
              { logGroupName: "/ralph/main-extra" },
              { logGroupName: "/ralph/main" },
            ],
          },
        ],
      },
    });
    await ensureLogGroup(clients, "/ralph/main", noop);
    expect((clients.logs as unknown as FakeClient).send).toHaveBeenCalledTimes(
      1,
    );
  });

  it("does not match a prefix-only result (regression: prefix vs exact)", async () => {
    // describeLogGroups returns a prefix match; we must filter for exact.
    const clients = fakeClients({
      logs: {
        DescribeLogGroupsCommand: [
          { logGroups: [{ logGroupName: "/ralph/main-extra" }] },
        ],
        CreateLogGroupCommand: [{}],
      },
    });
    await ensureLogGroup(clients, "/ralph/main", noop);
    expect((clients.logs as unknown as FakeClient).send).toHaveBeenCalledTimes(
      2,
    );
  });
});

// ---- ensureSecurityGroup ----

describe("ensureSecurityGroup", () => {
  it("creates in default VPC when missing — never opens an inbound rule", async () => {
    const clients = fakeClients({
      ec2: {
        DescribeVpcsCommand: [{ Vpcs: [{ VpcId: "vpc-default" }] }],
        DescribeSecurityGroupsCommand: [{ SecurityGroups: [] }],
        CreateSecurityGroupCommand: [{ GroupId: "sg-abcd" }],
      },
    });
    await ensureSecurityGroup(clients, "ralph-sg", "desc", noop);
    const ec2 = clients.ec2 as unknown as FakeClient;
    expect(ec2.send).toHaveBeenCalledTimes(3);
    // never an authorize-ingress (would be a 4th call)
    for (const call of ec2.send.mock.calls) {
      expect(
        (call[0] as { constructor: { name: string } }).constructor.name,
      ).not.toBe("AuthorizeSecurityGroupIngressCommand");
    }
  });

  it("skips when group already exists in default VPC", async () => {
    const clients = fakeClients({
      ec2: {
        DescribeVpcsCommand: [{ Vpcs: [{ VpcId: "vpc-default" }] }],
        DescribeSecurityGroupsCommand: [
          { SecurityGroups: [{ GroupId: "sg-existing" }] },
        ],
      },
    });
    await ensureSecurityGroup(clients, "ralph-sg", "desc", noop);
    expect((clients.ec2 as unknown as FakeClient).send).toHaveBeenCalledTimes(
      2,
    );
  });

  it("errors out cleanly when no default VPC", async () => {
    const clients = fakeClients({
      ec2: {
        DescribeVpcsCommand: [{ Vpcs: [] }],
      },
    });
    await expect(
      ensureSecurityGroup(clients, "ralph-sg", "desc", noop),
    ).rejects.toThrow(/no default VPC/);
  });
});

// ---- ensureIamRoleAndProfile ----

describe("ensureIamRoleAndProfile", () => {
  it("first run: creates role, attaches managed policy, puts inline doc, creates instance profile, adds role to profile", async () => {
    const clients = fakeClients({
      sts: {
        GetCallerIdentityCommand: [{ Account: "123456789012" }],
      },
      iam: {
        GetRoleCommand: [notFound()],
        CreateRoleCommand: [{}],
        ListAttachedRolePoliciesCommand: [{ AttachedPolicies: [] }],
        AttachRolePolicyCommand: [{}],
        GetRolePolicyCommand: [notFound()],
        PutRolePolicyCommand: [{}],
        GetInstanceProfileCommand: [notFound()],
        CreateInstanceProfileCommand: [{}],
        AddRoleToInstanceProfileCommand: [{}],
      },
    });
    await ensureIamRoleAndProfile(
      clients,
      "ralph-ec2-role",
      "ralph-ec2-profile",
      "/ralph/github-pat",
      "/ralph/claude-oauth-credential",
      "/ralph/main",
      "alias/ralph",
      noop,
    );
    const iam = clients.iam as unknown as FakeClient;
    const cmds = iam.send.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name,
    );
    expect(cmds).toContain("CreateRoleCommand");
    expect(cmds).toContain("AttachRolePolicyCommand");
    expect(cmds).toContain("PutRolePolicyCommand");
    expect(cmds).toContain("CreateInstanceProfileCommand");
    expect(cmds).toContain("AddRoleToInstanceProfileCommand");
  });

  it("second run: every state matches → zero create/put/attach calls", async () => {
    const desired = buildInlinePolicy(
      "123456789012",
      "/ralph/github-pat",
      "/ralph/claude-oauth-credential",
      "/ralph/main",
      "alias/ralph",
    );
    const clients = fakeClients({
      sts: {
        GetCallerIdentityCommand: [{ Account: "123456789012" }],
      },
      iam: {
        GetRoleCommand: [{ Role: { RoleName: "ralph-ec2-role" } }],
        ListAttachedRolePoliciesCommand: [
          { AttachedPolicies: [{ PolicyName: "AmazonSSMManagedInstanceCore" }] },
        ],
        GetRolePolicyCommand: [
          { PolicyDocument: JSON.stringify(desired) },
        ],
        GetInstanceProfileCommand: [
          {
            InstanceProfile: {
              InstanceProfileName: "ralph-ec2-profile",
              Roles: [{ RoleName: "ralph-ec2-role" }],
            },
          },
        ],
      },
    });
    await ensureIamRoleAndProfile(
      clients,
      "ralph-ec2-role",
      "ralph-ec2-profile",
      "/ralph/github-pat",
      "/ralph/claude-oauth-credential",
      "/ralph/main",
      "alias/ralph",
      noop,
    );
    const iam = clients.iam as unknown as FakeClient;
    const cmds = iam.send.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name,
    );
    expect(cmds).not.toContain("CreateRoleCommand");
    expect(cmds).not.toContain("AttachRolePolicyCommand");
    expect(cmds).not.toContain("PutRolePolicyCommand");
    expect(cmds).not.toContain("CreateInstanceProfileCommand");
    expect(cmds).not.toContain("AddRoleToInstanceProfileCommand");
  });

  it("inline policy diff: rewrites when existing differs", async () => {
    const stale = buildInlinePolicy(
      "123456789012",
      "/ralph/github-pat",
      "/ralph/old-key",
      "/ralph/main",
      "alias/ralph",
    );
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "123456789012" }] },
      iam: {
        GetRoleCommand: [{ Role: {} }],
        ListAttachedRolePoliciesCommand: [
          { AttachedPolicies: [{ PolicyName: "AmazonSSMManagedInstanceCore" }] },
        ],
        GetRolePolicyCommand: [
          { PolicyDocument: JSON.stringify(stale) },
        ],
        PutRolePolicyCommand: [{}],
        GetInstanceProfileCommand: [
          {
            InstanceProfile: {
              Roles: [{ RoleName: "ralph-ec2-role" }],
            },
          },
        ],
      },
    });
    await ensureIamRoleAndProfile(
      clients,
      "ralph-ec2-role",
      "ralph-ec2-profile",
      "/ralph/github-pat",
      "/ralph/claude-oauth-credential",
      "/ralph/main",
      "alias/ralph",
      noop,
    );
    const iam = clients.iam as unknown as FakeClient;
    const cmds = iam.send.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name,
    );
    expect(cmds).toContain("PutRolePolicyCommand");
  });
});

// ---- ensureAgentStuckLabel ----

describe("ensureAgentStuckLabel", () => {
  it("creates when missing on the target repo", () => {
    ghRunner.__queueStdout(""); // empty label list
    ensureAgentStuckLabel("owner/repo", "agent-stuck", noop);
    const calls = ghRunner.__calls();
    expect(calls.length).toBe(2);
    expect(calls[0]!.args).toContain("list");
    expect(calls[1]!.args).toContain("create");
    expect(calls[1]!.args).toContain("agent-stuck");
  });

  it("skips create when label already present", () => {
    ghRunner.__queueStdout("bug\nagent-stuck\nready-for-agent");
    ensureAgentStuckLabel("owner/repo", "agent-stuck", noop);
    const calls = ghRunner.__calls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toContain("list");
  });
});

// ---- runAll ----

describe("runAll", () => {
  it("first run on a clean account: one of every create call", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "123456789012" }] },
      kms: {
        DescribeKeyCommand: [notFound({ name: "NotFoundException" })],
        CreateKeyCommand: [{ KeyMetadata: { KeyId: "abcd-1234" } }],
        CreateAliasCommand: [{}],
      },
      ssm: {
        GetParameterCommand: [
          notFound({ name: "ParameterNotFound" }),
          notFound({ name: "ParameterNotFound" }),
        ],
        PutParameterCommand: [{}, {}],
      },
      logs: {
        DescribeLogGroupsCommand: [{ logGroups: [] }],
        CreateLogGroupCommand: [{}],
      },
      iam: {
        GetRoleCommand: [notFound()],
        CreateRoleCommand: [{}],
        ListAttachedRolePoliciesCommand: [{ AttachedPolicies: [] }],
        AttachRolePolicyCommand: [{}],
        GetRolePolicyCommand: [notFound()],
        PutRolePolicyCommand: [{}],
        GetInstanceProfileCommand: [notFound()],
        CreateInstanceProfileCommand: [{}],
        AddRoleToInstanceProfileCommand: [{}],
      },
      ec2: {
        DescribeVpcsCommand: [{ Vpcs: [{ VpcId: "vpc-default" }] }],
        DescribeSecurityGroupsCommand: [{ SecurityGroups: [] }],
        CreateSecurityGroupCommand: [{ GroupId: "sg-abcd" }],
      },
    });
    ghRunner.__queueStdout(""); // empty label list → triggers create
    await runAll({ clients, repo: "owner/repo", info: noop });

    // every "create-class" call exactly once
    const ssmPuts = (clients.ssm as unknown as FakeClient).send.mock.calls.filter(
      (c) =>
        (c[0] as { constructor: { name: string } }).constructor.name ===
        "PutParameterCommand",
    );
    expect(ssmPuts.length).toBe(2);

    const ghCalls = ghRunner.__calls();
    expect(ghCalls.some((c) => c.args.includes("create"))).toBe(true);
  });

  it("second run on a bootstrapped account is a no-op (zero create/put calls across services)", async () => {
    const desired = buildInlinePolicy(
      "123456789012",
      "/ralph/github-pat",
      "/ralph/claude-oauth-credential",
      "/ralph/main",
      "alias/ralph",
    );
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "123456789012" }] },
      kms: {
        DescribeKeyCommand: [{ KeyMetadata: { KeyId: "abcd" } }],
      },
      ssm: {
        GetParameterCommand: [{ Parameter: {} }, { Parameter: {} }],
      },
      logs: {
        DescribeLogGroupsCommand: [
          { logGroups: [{ logGroupName: "/ralph/main" }] },
        ],
      },
      iam: {
        GetRoleCommand: [{ Role: {} }],
        ListAttachedRolePoliciesCommand: [
          { AttachedPolicies: [{ PolicyName: "AmazonSSMManagedInstanceCore" }] },
        ],
        GetRolePolicyCommand: [
          { PolicyDocument: JSON.stringify(desired) },
        ],
        GetInstanceProfileCommand: [
          {
            InstanceProfile: {
              Roles: [{ RoleName: "ralph-ec2-role" }],
            },
          },
        ],
      },
      ec2: {
        DescribeVpcsCommand: [{ Vpcs: [{ VpcId: "vpc-default" }] }],
        DescribeSecurityGroupsCommand: [
          { SecurityGroups: [{ GroupId: "sg-existing" }] },
        ],
      },
    });
    ghRunner.__queueStdout("agent-stuck\nbug");
    await runAll({ clients, repo: "owner/repo", info: noop });

    function cmdNames(c: FakeClient) {
      return c.send.mock.calls.map(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name,
      );
    }
    expect(cmdNames(clients.kms as unknown as FakeClient)).not.toContain(
      "CreateKeyCommand",
    );
    expect(cmdNames(clients.ssm as unknown as FakeClient)).not.toContain(
      "PutParameterCommand",
    );
    expect(cmdNames(clients.logs as unknown as FakeClient)).not.toContain(
      "CreateLogGroupCommand",
    );
    expect(cmdNames(clients.iam as unknown as FakeClient)).not.toContain(
      "CreateRoleCommand",
    );
    expect(cmdNames(clients.iam as unknown as FakeClient)).not.toContain(
      "PutRolePolicyCommand",
    );
    expect(cmdNames(clients.ec2 as unknown as FakeClient)).not.toContain(
      "CreateSecurityGroupCommand",
    );
    expect(ghRunner.__calls().some((c) => c.args.includes("create"))).toBe(
      false,
    );
  });
});

// ---- canonicalJson ----

describe("canonicalJson", () => {
  it("sorts object keys recursively for stable comparison", () => {
    const a = canonicalJson({ b: { d: 1, c: 2 }, a: 3 });
    const b = canonicalJson({ a: 3, b: { c: 2, d: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});
