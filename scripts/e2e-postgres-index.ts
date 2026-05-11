#!/usr/bin/env tsx

import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadConfig } from "../src/server/config.js";
import { FileStore } from "../src/storage/file-store.js";
import { artifacts, attempts, eventCheckpoints, pullRequests, reviews, runEvents, runs, schemaMigrations, sourceClaims, tasksmithSchema } from "../src/storage/postgres-schema.js";

const baseDatabaseUrl = process.env.TASKSMITH_TEST_DATABASE_URL;

async function main(): Promise<void> {
  if (!baseDatabaseUrl) {
    console.log("Postgres app-state e2e skipped; set TASKSMITH_TEST_DATABASE_URL to run it.");
    return;
  }

  const schema = `tasksmith_e2e_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  assertSafeIdentifier(schema);
  const adminPool = new Pool({ connectionString: baseDatabaseUrl, application_name: "tasksmith-e2e-admin" });
  const databaseUrl = withSearchPath(baseDatabaseUrl, schema);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasksmith-postgres-index-e2e-"));

  const previousDataDir = process.env.TASKSMITH_DATA_DIR;
  const previousDatabaseUrl = process.env.TASKSMITH_DATABASE_URL;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    process.env.TASKSMITH_DATA_DIR = tempDir;
    process.env.TASKSMITH_DATABASE_URL = databaseUrl;

    const config = loadConfig();
    const store = new FileStore(config);
    await store.init();

    const run = await store.createRun({
      title: "Postgres metadata e2e",
      repoKey: "tasksmith",
      adapter: "demo",
      prompt: "Index this run metadata, not Pi chat files.",
      source: {
        type: "github_issue",
        key: "Kaldy14/tasksmith#9999",
        title: "Postgres metadata e2e",
        url: "https://github.com/Kaldy14/tasksmith/issues/9999",
        labels: ["tasksmith"],
      },
      claimKey: "github:Kaldy14/tasksmith#9999",
    });

    const { claim } = await store.tryCreateSourceClaim({
      key: "github:Kaldy14/tasksmith#9999",
      provider: "github",
      sourceType: "github_issue",
      sourceKey: "Kaldy14/tasksmith#9999",
      sourceUrl: "https://github.com/Kaldy14/tasksmith/issues/9999",
      repoKey: "tasksmith",
    });
    await store.updateSourceClaim(claim.key, { runId: run.id, status: "run_created" });

    const running = await store.updateRun(run.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      sessionId: "session-e2e",
      sessionFile: path.join(store.pathsForRun(run.id).sessionDir, "session.jsonl"),
    });
    await store.appendEvent(running, { type: "run_status", status: "running", detail: "Postgres index e2e" });
    await store.appendEvent(running, { type: "attempt_done", status: "completed", summary: "Postgres index e2e attempt complete" });
    await store.recordReview({
      runId: run.id,
      status: "passed",
      summary: "Review passed in Postgres index e2e.",
      findings: [],
      diffStat: "README.md | 1 +",
    });
    await store.recordPullRequest({
      runId: run.id,
      provider: "github",
      url: "https://github.com/Kaldy14/tasksmith/pull/9999",
      number: 9999,
      branch: "tasksmith/postgres-index-e2e",
      baseBranch: "main",
      title: "Postgres metadata e2e",
      body: "TaskSmith e2e body",
    });
    await store.updateRun(run.id, { status: "pr_created", finishedAt: new Date().toISOString() });
    await store.close();

    const pool = new Pool({ connectionString: databaseUrl, application_name: "tasksmith-e2e-assert" });
    const db = drizzle(pool, { schema: tasksmithSchema });
    try {
      const runRow = await one(await db
        .select({
          status: runs.status,
          sourceKey: runs.sourceKey,
          currentAttemptId: runs.currentAttemptId,
          artifactPaths: runs.artifactPaths,
        })
        .from(runs)
        .where(eq(runs.id, run.id)));
      assertEqual(runRow.status, "pr_created", "run status should be indexed");
      assertEqual(runRow.sourceKey, "Kaldy14/tasksmith#9999", "source key should be indexed");
      assertEqual(runRow.currentAttemptId, "attempt-1", "attempt id should be indexed");
      const rawEventsPath = runRow.artifactPaths.rawEventsPath;
      assert(typeof rawEventsPath === "string" && rawEventsPath.endsWith("pi-raw.jsonl"), "artifact path should point at raw Pi JSONL event file");

      const claimRow = await one(await db
        .select({ status: sourceClaims.status, runId: sourceClaims.runId })
        .from(sourceClaims)
        .where(eq(sourceClaims.key, claim.key)));
      assertEqual(claimRow.status, "run_created", "source claim status should be indexed");
      assertEqual(claimRow.runId, run.id, "source claim run id should be indexed");

      const eventRow = await one(await db
        .select({ sequence: runEvents.sequence, type: runEvents.type, payload: runEvents.payload })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "run_status"))));
      assertEqual(eventRow.sequence, 1, "normalized event sequence should be stored in Postgres");
      assertEqual(eventRow.type, "run_status", "normalized event type should be stored in Postgres");
      assertEqual(eventRow.payload.type, "run_status", "normalized event payload should be stored in Postgres");
      assert(!(await exists(store.pathsForRun(run.id).normalizedEventsPath)), "Postgres mode should not duplicate normalized events into JSONL");

      const checkpointRow = await one(await db
        .select({
          lastSequence: eventCheckpoints.lastSequence,
          lastEventType: eventCheckpoints.lastEventType,
          rawEventsPath: eventCheckpoints.rawEventsPath,
        })
        .from(eventCheckpoints)
        .where(eq(eventCheckpoints.runId, run.id)));
      assertEqual(checkpointRow.lastSequence, 2, "event checkpoint sequence should be indexed");
      assertEqual(checkpointRow.lastEventType, "attempt_done", "event checkpoint type should be indexed");
      assert(checkpointRow.rawEventsPath.endsWith("pi-raw.jsonl"), "checkpoint should point to raw Pi event JSONL");

      const attemptRow = await one(await db
        .select({ status: attempts.status, attemptId: attempts.attemptId })
        .from(attempts)
        .where(eq(attempts.runId, run.id)));
      assertEqual(attemptRow.attemptId, "attempt-1", "attempt row should be indexed");
      assertEqual(attemptRow.status, "completed", "attempt completion should be indexed from attempt_done event");

      const artifactCount = await one(await db
        .select({ count: sql<number>`count(*)::int` })
        .from(artifacts)
        .where(eq(artifacts.runId, run.id)));
      assert(artifactCount.count >= 5, "run artifact pointers should be indexed");

      const pullRequestRow = await one(await db
        .select({ url: pullRequests.url, number: pullRequests.number })
        .from(pullRequests)
        .where(eq(pullRequests.runId, run.id)));
      assertEqual(pullRequestRow.url, "https://github.com/Kaldy14/tasksmith/pull/9999", "PR URL should be indexed");
      assertEqual(pullRequestRow.number, 9999, "PR number should be indexed");

      const reviewRow = await one(await db
        .select({ status: reviews.status, findingCount: sql<number>`jsonb_array_length(${reviews.findings})` })
        .from(reviews)
        .where(eq(reviews.runId, run.id)));
      assertEqual(reviewRow.status, "passed", "review status should be indexed");
      assertEqual(reviewRow.findingCount, 0, "review findings should be indexed");

      const migrations = await one(await db.select({ count: sql<number>`count(*)::int` }).from(schemaMigrations));
      assert(migrations.count >= 1, "schema migrations should be recorded");
    } finally {
      await pool.end();
    }

    console.log("Postgres app-state e2e passed");
  } finally {
    process.env.TASKSMITH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.TASKSMITH_DATABASE_URL;
    else process.env.TASKSMITH_DATABASE_URL = previousDatabaseUrl;
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await adminPool.end();
    if (process.env.TASKSMITH_KEEP_E2E_ARTIFACTS === "1") console.log(`Keeping artifacts at ${tempDir}`);
    else await rm(tempDir, { recursive: true, force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function one<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
  return rows[0]!;
}

function withSearchPath(rawUrl: string, schema: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function assertSafeIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
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
