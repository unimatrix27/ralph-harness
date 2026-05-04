#!/usr/bin/env node

const IMDS_BASE = "http://169.254.169.254/latest";
const IMDS_TIMEOUT_MS = 1000;

async function fetchInstanceId(): Promise<string> {
  try {
    const tokenRes = await fetch(`${IMDS_BASE}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return "unknown";
    const token = (await tokenRes.text()).trim();
    if (!token) return "unknown";

    const idRes = await fetch(`${IMDS_BASE}/meta-data/instance-id`, {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    if (!idRes.ok) return "unknown";
    const id = (await idRes.text()).trim();
    return id || "unknown";
  } catch {
    return "unknown";
  }
}

const instance = await fetchInstanceId();
process.stdout.write(`RALPH_HELLO_FROM_TS instance=${instance}\n`);
process.exit(0);
