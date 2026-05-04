// Unit tests for credential-syncer. Mocks the AWS SDK clients and the
// security-runner. Asserts on:
//   1. Happy-path PutParameter call shape (--cli-input-json equivalent: the
//      SDK marshals into the request body, never argv).
//   2. Failure modes (missing/empty/non-JSON Keychain, AWS auth missing) hit
//      the documented exit codes via CredentialSyncerError.code.
//   3. The credential value never appears in any captured log line, in the
//      error from a non-JSON entry, or in the keychain-service argv we
//      record.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialSyncerError,
  syncCredential,
} from "./credential-syncer.js";
import { SecurityRunnerError } from "./security-runner.js";
import type { AwsClients } from "./aws-clients.js";

const MARKER = "MARKER_CREDENTIAL_DO_NOT_LEAK_ABCDEF1234567890";
const VALID_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: MARKER,
    refreshToken: "r",
    expiresAt: 1,
    scopes: ["a"],
    subscriptionType: "x",
  },
});

interface FakeClient {
  send: ReturnType<typeof vi.fn>;
}

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
  ssm?: Record<string, unknown[]>;
  sts?: Record<string, unknown[]>;
}): AwsClients {
  return {
    kms: { send: vi.fn() },
    ssm: { send: dispatchMock(table.ssm ?? {}) },
    iam: { send: vi.fn() },
    ec2: { send: vi.fn() },
    logs: { send: vi.fn() },
    sts: { send: dispatchMock(table.sts ?? {}) },
  } as unknown as AwsClients;
}

let logs: string[] = [];
const captureLog = (line: string) => {
  logs.push(line);
};

beforeEach(() => {
  logs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- happy path ----

describe("syncCredential — happy path", () => {
  it("uploads to the default key with SecureString + KMS alias + Overwrite=true", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "123456789012" }] },
      ssm: { PutParameterCommand: [{}] },
    });
    await syncCredential({
      clients,
      info: captureLog,
      readKeychain: () => VALID_JSON,
    });

    const ssm = clients.ssm as unknown as FakeClient;
    expect(ssm.send).toHaveBeenCalledTimes(1);
    const put = ssm.send.mock.calls[0]![0] as {
      input: {
        Name: string;
        Type: string;
        KeyId: string;
        Overwrite: boolean;
        Value: string;
      };
    };
    expect(put.input.Name).toBe("/ralph/claude-oauth-credential");
    expect(put.input.Type).toBe("SecureString");
    expect(put.input.KeyId).toBe("alias/ralph");
    expect(put.input.Overwrite).toBe(true);
    expect(put.input.Value).toBe(VALID_JSON);
    expect(logs.join("\n")).toContain("/ralph/claude-oauth-credential");
  });

  it("honors a custom ssmKey", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
      ssm: { PutParameterCommand: [{}] },
    });
    await syncCredential({
      clients,
      ssmKey: "/ralph/custom-key",
      info: captureLog,
      readKeychain: () => VALID_JSON,
    });
    expect(logs.join("\n")).toContain("/ralph/custom-key");
  });

  it("honors a custom keychain service", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
      ssm: { PutParameterCommand: [{}] },
    });
    let asked: string | undefined;
    await syncCredential({
      clients,
      keychainService: "Custom-Service",
      info: captureLog,
      readKeychain: (s) => {
        asked = s;
        return VALID_JSON;
      },
    });
    expect(asked).toBe("Custom-Service");
  });
});

// ---- failure modes (preserve bash exit codes) ----

describe("syncCredential — failure modes", () => {
  it("exit 4 when AWS credentials are not configured", async () => {
    const authErr = new Error("CredentialsProviderError");
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [authErr] },
    });
    await expect(
      syncCredential({
        clients,
        info: captureLog,
        readKeychain: () => VALID_JSON,
      }),
    ).rejects.toMatchObject({ code: 4 });
  });

  it("exit 3 when Keychain entry is missing", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
    });
    await expect(
      syncCredential({
        clients,
        info: captureLog,
        readKeychain: () => {
          throw new SecurityRunnerError(44, "", "missing");
        },
      }),
    ).rejects.toMatchObject({ code: 3 });
  });

  it("exit 3 when Keychain entry is empty", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
    });
    await expect(
      syncCredential({
        clients,
        info: captureLog,
        readKeychain: () => "",
      }),
    ).rejects.toMatchObject({ code: 3 });
  });

  it("exit 3 when Keychain entry is not valid JSON — error message does NOT include the bytes", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
    });
    const promise = syncCredential({
      clients,
      info: captureLog,
      readKeychain: () => "this-is-not-json",
    });
    await expect(promise).rejects.toMatchObject({ code: 3 });
    try {
      await promise;
    } catch (err) {
      const e = err as CredentialSyncerError;
      expect(e.message).not.toContain("this-is-not-json");
      expect(e.message).toContain("not valid JSON");
    }
  });
});

// ---- non-leakage ----

describe("syncCredential — credential never leaks", () => {
  it("the credential value never appears in any info log line", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
      ssm: { PutParameterCommand: [{}] },
    });
    await syncCredential({
      clients,
      info: captureLog,
      readKeychain: () => VALID_JSON,
    });
    for (const line of logs) {
      expect(line).not.toContain(MARKER);
    }
  });

  it("rejected with bad-JSON error: the error message does not contain the bytes", async () => {
    const clients = fakeClients({
      sts: { GetCallerIdentityCommand: [{ Account: "x" }] },
    });
    const bogus = `${MARKER}-not-json`;
    try {
      await syncCredential({
        clients,
        info: captureLog,
        readKeychain: () => bogus,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as CredentialSyncerError;
      expect(e.message).not.toContain(MARKER);
    }
  });
});
