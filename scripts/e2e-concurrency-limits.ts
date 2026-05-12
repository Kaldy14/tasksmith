#!/usr/bin/env tsx

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { FileStore } from "../src/storage/file-store.js";

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-concurrency-e2e-"));
  const previousDataDir = process.env.TASKSMITH_DATA_DIR;
  const previousDatabaseUrl = process.env.TASKSMITH_DATABASE_URL;
  const previousAuthEnabled = process.env.TASKSMITH_AUTH_ENABLED;

  try {
    process.env.TASKSMITH_DATA_DIR = tempDir;
    delete process.env.TASKSMITH_DATABASE_URL;
    process.env.TASKSMITH_AUTH_ENABLED = "0";

    await testGlobalLimit(path.join(tempDir, "global"));
    await testPerRepoLimitAndDifferentRepoCapacity(path.join(tempDir, "per-repo"));
    await testCapacityReleaseAfterTerminalStatus(path.join(tempDir, "release"));
    await testCapacityAnnotationsPreserveNonCapacityErrors(path.join(tempDir, "annotations"));

    console.log("Concurrency limits e2e passed");
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

async function testGlobalLimit(dataDir: string): Promise<void> {
  process.env.TASKSMITH_DATA_DIR = dataDir;
  const store = new FileStore(loadConfig());
  await store.init();
  const first = await store.createRun({ title: "global first", repoKey: "repo-a", adapter: "demo", prompt: "one" });
  const second = await store.createRun({ title: "global second", repoKey: "repo-b", adapter: "demo", prompt: "two" });

  const claimed = await store.claimNextQueuedRun("worker-global", 60_000, { maxActiveRuns: 1 });
  assertEqual(claimed?.id, first.id, "global limit should claim oldest run");
  const blocked = await store.claimNextQueuedRun("worker-global", 60_000, { maxActiveRuns: 1 });
  assertEqual(blocked, undefined, "global limit should leave second run queued");
  assertEqual((await store.getRun(second.id))?.status, "queued", "second run remains queued at global capacity");
  await store.close();
}

async function testPerRepoLimitAndDifferentRepoCapacity(dataDir: string): Promise<void> {
  process.env.TASKSMITH_DATA_DIR = dataDir;
  const store = new FileStore(loadConfig());
  await store.init();
  const first = await store.createRun({ title: "repo first", repoKey: "same-repo", adapter: "demo", prompt: "one" });
  const second = await store.createRun({ title: "repo second", repoKey: "same-repo", adapter: "demo", prompt: "two" });
  const third = await store.createRun({ title: "repo other", repoKey: "other-repo", adapter: "demo", prompt: "three" });

  const claimedFirst = await store.claimNextQueuedRun("worker-repo", 60_000, { maxActiveRuns: 2, maxActiveRunsPerRepo: 1 });
  assertEqual(claimedFirst?.id, first.id, "per-repo test should claim first run");
  const claimedOtherRepo = await store.claimNextQueuedRun("worker-repo", 60_000, { maxActiveRuns: 2, maxActiveRunsPerRepo: 1 });
  assertEqual(claimedOtherRepo?.id, third.id, "scheduler should skip same-repo blocked run and claim different repo");
  assertEqual((await store.getRun(second.id))?.status, "queued", "same repo run remains queued");
  await store.close();
}

async function testCapacityReleaseAfterTerminalStatus(dataDir: string): Promise<void> {
  process.env.TASKSMITH_DATA_DIR = dataDir;
  const store = new FileStore(loadConfig());
  await store.init();
  const first = await store.createRun({ title: "release first", repoKey: "release-repo", adapter: "demo", prompt: "one" });
  const second = await store.createRun({ title: "release second", repoKey: "release-repo", adapter: "demo", prompt: "two" });

  const claimedFirst = await store.claimNextQueuedRun("worker-release", 60_000, { maxActiveRuns: 1, maxActiveRunsPerRepo: 1 });
  assertEqual(claimedFirst?.id, first.id, "release test should claim first run");
  assertEqual(await store.claimNextQueuedRun("worker-release", 60_000, { maxActiveRuns: 1, maxActiveRunsPerRepo: 1 }), undefined, "second run should wait for capacity");
  await store.updateRun(first.id, { status: "failed", finishedAt: new Date().toISOString() });
  const claimedSecond = await store.claimNextQueuedRun("worker-release", 60_000, { maxActiveRuns: 1, maxActiveRunsPerRepo: 1 });
  assertEqual(claimedSecond?.id, second.id, "capacity should release after failure");
  await store.close();
}

async function testCapacityAnnotationsPreserveNonCapacityErrors(dataDir: string): Promise<void> {
  process.env.TASKSMITH_DATA_DIR = dataDir;
  const store = new FileStore(loadConfig());
  await store.init();
  const active = await store.createRun({ title: "annotation active", repoKey: "annotation-repo", adapter: "demo", prompt: "active" });
  const customError = await store.createRun({ title: "custom error", repoKey: "annotation-repo", adapter: "demo", prompt: "custom" });
  const capacityError = await store.createRun({ title: "capacity error", repoKey: "annotation-repo", adapter: "demo", prompt: "capacity" });
  const unchangedCapacityError = await store.createRun({ title: "unchanged capacity error", repoKey: "annotation-repo", adapter: "demo", prompt: "unchanged" });
  const emptyError = await store.createRun({ title: "empty error", repoKey: "annotation-repo", adapter: "demo", prompt: "empty" });

  const expectedCapacityError = "Queued because run capacity is full: global limit 1 reached.";
  const customErrorBefore = await store.updateRun(customError.id, { error: "Verifier failed before scheduling" });
  const capacityErrorBefore = await store.updateRun(capacityError.id, { error: "Queued because run capacity is full: stale repository limit." });
  const unchangedCapacityErrorBefore = await store.updateRun(unchangedCapacityError.id, { error: expectedCapacityError });
  const emptyErrorBefore = (await store.getRun(emptyError.id))!;
  assertEqual((await store.claimNextQueuedRun("worker-annotations", 60_000, { maxActiveRuns: 1 }))?.id, active.id, "annotation test should claim active run");
  assertEqual(await store.claimNextQueuedRun("worker-annotations", 60_000, { maxActiveRuns: 1 }), undefined, "remaining runs should wait for capacity");

  const customErrorAfter = (await store.getRun(customError.id))!;
  const capacityErrorAfter = (await store.getRun(capacityError.id))!;
  const unchangedCapacityErrorAfter = (await store.getRun(unchangedCapacityError.id))!;
  const emptyErrorAfter = (await store.getRun(emptyError.id))!;
  assertEqual(customErrorAfter.error, "Verifier failed before scheduling", "non-capacity error should be preserved while blocked");
  assertEqual(customErrorAfter.updatedAt, customErrorBefore.updatedAt, "non-capacity error should not update timestamps while blocked");
  assertEqual(capacityErrorAfter.error, expectedCapacityError, "capacity error should update to latest reason");
  assertGreaterThan(capacityErrorAfter.updatedAt, capacityErrorBefore.updatedAt, "changed capacity error should update timestamps while blocked");
  assertEqual(unchangedCapacityErrorAfter.error, expectedCapacityError, "unchanged capacity error should keep the same reason while blocked");
  assertEqual(unchangedCapacityErrorAfter.updatedAt, unchangedCapacityErrorBefore.updatedAt, "unchanged capacity error should not update timestamps while blocked");
  assertEqual(emptyErrorAfter.error, expectedCapacityError, "empty error should receive capacity reason");
  assertGreaterThan(emptyErrorAfter.updatedAt, emptyErrorBefore.updatedAt, "empty error should update timestamps while blocked");
  await store.close();
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertGreaterThan(actual: string, expected: string, message: string): void {
  if (actual <= expected) throw new Error(`${message}: expected ${JSON.stringify(actual)} to be greater than ${JSON.stringify(expected)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
