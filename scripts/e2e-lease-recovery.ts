#!/usr/bin/env tsx

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/server/config.js";
import { FileStore } from "../src/storage/file-store.js";

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-lease-recovery-e2e-"));
  const previousDataDir = process.env.TASKSMITH_DATA_DIR;
  const previousDatabaseUrl = process.env.TASKSMITH_DATABASE_URL;
  const previousAuthEnabled = process.env.TASKSMITH_AUTH_ENABLED;

  try {
    process.env.TASKSMITH_DATA_DIR = tempDir;
    delete process.env.TASKSMITH_DATABASE_URL;
    process.env.TASKSMITH_AUTH_ENABLED = "0";

    const store = new FileStore(loadConfig());
    await store.init();

    const noLease = await store.createRun({
      title: "Active legacy run without lease",
      repoKey: "lease-e2e",
      adapter: "demo",
      prompt: "Do not recover this run as stale.",
    });
    await store.updateRun(noLease.id, { status: "running" });

    const noHeartbeatRun = await store.createRun({
      title: "Active legacy run without heartbeat",
      repoKey: "lease-e2e",
      adapter: "demo",
      prompt: "Do not recover this run as stale.",
    });
    const noHeartbeatClaimed = await store.claimNextQueuedRun("worker-no-heartbeat", 60_000);
    assert(noHeartbeatClaimed?.id === noHeartbeatRun.id, "expected to claim no-heartbeat run");
    const { lastHeartbeatAt: _lastHeartbeatAt, ...leaseWithoutHeartbeat } = noHeartbeatClaimed.lease!;
    await store.updateRun(noHeartbeatRun.id, {
      status: "running",
      lease: leaseWithoutHeartbeat,
    });

    const expiredNoHeartbeatRun = await store.createRun({
      title: "Expired lease run without heartbeat",
      repoKey: "lease-e2e",
      adapter: "demo",
      prompt: "Recover this run as stale from explicit expiry metadata.",
    });
    const expiredNoHeartbeatClaimed = await store.claimNextQueuedRun("worker-expired-no-heartbeat", 60_000);
    assert(expiredNoHeartbeatClaimed?.id === expiredNoHeartbeatRun.id, "expected to claim expired no-heartbeat run");
    const { lastHeartbeatAt: _expiredNoHeartbeatAt, ...expiredLeaseWithoutHeartbeat } = expiredNoHeartbeatClaimed.lease!;
    await store.updateRun(expiredNoHeartbeatRun.id, {
      lease: { ...expiredLeaseWithoutHeartbeat, expiresAt: "2000-01-01T00:00:00.000Z" },
    });

    const expiredRun = await store.createRun({
      title: "Expired lease run",
      repoKey: "lease-e2e",
      adapter: "demo",
      prompt: "Recover this run as stale.",
    });
    const expiredClaimed = await store.claimNextQueuedRun("worker-expired", 1);
    assert(expiredClaimed?.id === expiredRun.id, "expected to claim expired run");
    await delay(5);

    const recovered = await store.recoverStaleLeases(1);
    assertEqual(recovered.length, 2, "only runs with real expired lease metadata should be recovered");
    assert(recovered.some((run) => run.id === expiredRun.id), "expired heartbeat lease run should be recovered");
    assert(recovered.some((run) => run.id === expiredNoHeartbeatRun.id), "expired explicit lease expiry should be recovered without heartbeat");

    const noLeaseAfter = await store.getRun(noLease.id);
    assertEqual(noLeaseAfter?.status, "running", "missing lease metadata should not be marked expired");

    const noHeartbeatAfter = await store.getRun(noHeartbeatRun.id);
    assertEqual(noHeartbeatAfter?.status, "running", "missing heartbeat metadata should not be marked expired");

    const expiredNoHeartbeatAfter = await store.getRun(expiredNoHeartbeatRun.id);
    assertEqual(expiredNoHeartbeatAfter?.status, "queued", "expired explicit lease expiry should be requeued");
    assert(!expiredNoHeartbeatAfter?.lease, "recovered explicit expiry run should have lease cleared");

    const expiredAfter = await store.getRun(expiredRun.id);
    assertEqual(expiredAfter?.status, "queued", "expired claimed lease should be requeued");
    assert(!expiredAfter?.lease, "recovered run should have lease cleared");

    await store.close();
    console.log("Lease recovery e2e passed");
  } finally {
    process.env.TASKSMITH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.TASKSMITH_DATABASE_URL;
    else process.env.TASKSMITH_DATABASE_URL = previousDatabaseUrl;
    if (previousAuthEnabled === undefined) delete process.env.TASKSMITH_AUTH_ENABLED;
    else process.env.TASKSMITH_AUTH_ENABLED = previousAuthEnabled;
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") console.log(`Keeping artifacts at ${tempDir}`);
    else await rm(tempDir, { recursive: true, force: true });
  }
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
