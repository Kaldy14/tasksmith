import { randomUUID } from "node:crypto";
import { and, eq, gt, notInArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type {
  AttemptStatus,
  CreateSourceClaimInput,
  NormalizedRunEvent,
  PullRequestRecord,
  ReviewRecord,
  RunPaths,
  RunRecord,
  RunSourceType,
  RunStatus,
  SourceClaim,
  SourceClaimStatus,
  StoredRunEvent,
  RuntimeAdapter,
} from "../domain/types.js";
import {
  artifacts,
  attempts,
  controlMessages,
  eventCheckpoints,
  pullRequests,
  reviewFindings,
  reviews,
  runEvents,
  runs,
  schemaMigrations,
  sourceClaims,
  tasksmithSchema,
} from "./postgres-schema.js";

interface Migration {
  version: number;
  name: string;
  statements: readonly SQL[];
}

type RunRow = typeof runs.$inferSelect;
type SourceClaimRow = typeof sourceClaims.$inferSelect;
type PullRequestRow = typeof pullRequests.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "metadata_index_foundation",
    statements: [
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_runs (
          id text PRIMARY KEY,
          source_type text NOT NULL,
          source_key text,
          source_url text,
          title text NOT NULL,
          prompt text NOT NULL DEFAULT '',
          repo_key text NOT NULL,
          adapter text NOT NULL,
          status text NOT NULL,
          current_attempt_id text NOT NULL,
          claim_key text,
          run_dir text NOT NULL,
          workspace_dir text NOT NULL,
          session_id text,
          session_file text,
          error text,
          source_snapshot jsonb,
          pull_request jsonb,
          artifact_paths jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          started_at timestamptz,
          finished_at timestamptz
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_runs_status_idx ON tasksmith_runs(status)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_runs_repo_status_idx ON tasksmith_runs(repo_key, status)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_runs_source_idx ON tasksmith_runs(source_type, source_key)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_runs_updated_idx ON tasksmith_runs(updated_at DESC)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_source_claims (
          key text PRIMARY KEY,
          provider text NOT NULL,
          source_type text NOT NULL,
          source_key text NOT NULL,
          source_url text,
          repo_key text NOT NULL,
          run_id text,
          status text NOT NULL,
          error text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_source_claims_run_idx ON tasksmith_source_claims(run_id)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_source_claims_source_idx ON tasksmith_source_claims(provider, source_key)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_pull_requests (
          id text PRIMARY KEY,
          run_id text NOT NULL UNIQUE,
          provider text NOT NULL,
          url text NOT NULL,
          number integer,
          branch text NOT NULL,
          base_branch text NOT NULL,
          title text NOT NULL,
          body text NOT NULL,
          status text NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_pull_requests_status_idx ON tasksmith_pull_requests(status)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_reviews (
          id text PRIMARY KEY,
          run_id text NOT NULL UNIQUE,
          status text NOT NULL,
          summary text NOT NULL,
          findings jsonb NOT NULL DEFAULT '[]'::jsonb,
          diff_stat text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_reviews_status_idx ON tasksmith_reviews(status)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_event_checkpoints (
          run_id text PRIMARY KEY,
          normalized_events_path text NOT NULL,
          raw_events_path text NOT NULL,
          control_events_path text NOT NULL,
          last_sequence integer NOT NULL DEFAULT 0,
          last_event_id text,
          last_event_type text,
          last_event_created_at timestamptz,
          updated_at timestamptz NOT NULL
        )
      `,
    ],
  },
  {
    version: 2,
    name: "postgres_primary_app_state",
    statements: [
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS prompt text NOT NULL DEFAULT ''`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_attempts (
          id text PRIMARY KEY,
          run_id text NOT NULL,
          attempt_id text NOT NULL,
          adapter text NOT NULL,
          status text NOT NULL,
          started_at timestamptz,
          finished_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          UNIQUE (run_id, attempt_id)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_attempts_run_idx ON tasksmith_attempts(run_id)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_attempts_status_idx ON tasksmith_attempts(status)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_run_events (
          id text PRIMARY KEY,
          run_id text NOT NULL,
          attempt_id text NOT NULL,
          sequence integer NOT NULL,
          type text NOT NULL,
          payload jsonb NOT NULL,
          artifact_id text,
          raw_ref jsonb,
          created_at timestamptz NOT NULL,
          UNIQUE (run_id, sequence)
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_run_events_run_created_idx ON tasksmith_run_events(run_id, created_at)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_run_events_type_idx ON tasksmith_run_events(type)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_control_messages (
          id text PRIMARY KEY,
          run_id text NOT NULL,
          attempt_id text,
          kind text NOT NULL,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_control_messages_run_idx ON tasksmith_control_messages(run_id)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_artifacts (
          id text PRIMARY KEY,
          run_id text NOT NULL,
          attempt_id text,
          kind text NOT NULL,
          path text NOT NULL,
          size_bytes integer,
          sha256 text,
          content_type text,
          redaction_state text NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_artifacts_run_idx ON tasksmith_artifacts(run_id)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_artifacts_kind_idx ON tasksmith_artifacts(kind)`,
      sql`
        CREATE TABLE IF NOT EXISTS tasksmith_review_findings (
          id text PRIMARY KEY,
          review_id text NOT NULL,
          run_id text NOT NULL,
          severity text NOT NULL,
          title text NOT NULL,
          description text NOT NULL,
          file text,
          line integer,
          suggested_fix text,
          created_at timestamptz NOT NULL
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_review_findings_run_idx ON tasksmith_review_findings(run_id)`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_review_findings_severity_idx ON tasksmith_review_findings(severity)`,
    ],
  },
  {
    version: 3,
    name: "nullable_legacy_normalized_event_path",
    statements: [
      sql`ALTER TABLE tasksmith_event_checkpoints ALTER COLUMN normalized_events_path DROP NOT NULL`,
    ],
  },
  {
    version: 4,
    name: "better_auth_email_password",
    statements: [
      sql`
        CREATE TABLE IF NOT EXISTS "user" (
          id text PRIMARY KEY,
          name text NOT NULL,
          email text NOT NULL UNIQUE,
          email_verified boolean NOT NULL DEFAULT false,
          image text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "session" (
          id text PRIMARY KEY,
          expires_at timestamptz NOT NULL,
          token text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ip_address text,
          user_agent text,
          user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session"(user_id)`,
      sql`
        CREATE TABLE IF NOT EXISTS "account" (
          id text PRIMARY KEY,
          account_id text NOT NULL,
          provider_id text NOT NULL,
          user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
          access_token text,
          refresh_token text,
          id_token text,
          access_token_expires_at timestamptz,
          refresh_token_expires_at timestamptz,
          scope text,
          password text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS account_user_id_idx ON "account"(user_id)`,
      sql`
        CREATE TABLE IF NOT EXISTS "verification" (
          id text PRIMARY KEY,
          identifier text NOT NULL,
          value text NOT NULL,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier)`,
    ],
  },
  {
    version: 5,
    name: "ci_fix_attempt_counter",
    statements: [
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS ci_fix_attempts integer NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 6,
    name: "review_fix_attempt_counter",
    statements: [
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS review_fix_attempts integer NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 7,
    name: "worker_run_leases",
    statements: [
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS worker_id text`,
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`,
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz`,
      sql`ALTER TABLE tasksmith_runs ADD COLUMN IF NOT EXISTS lease_attempt integer NOT NULL DEFAULT 0`,
      sql`CREATE INDEX IF NOT EXISTS tasksmith_runs_lease_idx ON tasksmith_runs(status, lease_expires_at)`,
    ],
  },
];

export class PostgresMetadataIndex {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase<typeof tasksmithSchema>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, application_name: "tasksmith" });
    this.db = drizzle(this.pool, { schema: tasksmithSchema });
  }

  async init(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS tasksmith_schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const migration of migrations) {
        const applied = await tx
          .select({ version: schemaMigrations.version })
          .from(schemaMigrations)
          .where(eq(schemaMigrations.version, migration.version))
          .limit(1);
        if (applied.length > 0) continue;
        for (const statement of migration.statements) await tx.execute(statement);
        await tx.insert(schemaMigrations).values({ version: migration.version, name: migration.name }).onConflictDoNothing();
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertRun(run: RunRecord, paths: RunPaths): Promise<void> {
    await this.db.insert(runs)
      .values(runToInsert(run, paths))
      .onConflictDoUpdate({
        target: runs.id,
        set: runToUpdate(run, paths),
        where: sql`${runs.updatedAt} <= ${run.updatedAt}`,
      });
    await this.upsertAttempt(run, "queued");
    await this.upsertRunArtifacts(run, paths);
  }

  async listRuns(): Promise<RunRecord[]> {
    const rows = await this.db.select().from(runs).orderBy(sql`${runs.createdAt} DESC`);
    return rows.map(runFromRow);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  async claimNextQueuedRun(now: string, workerId: string, leaseTimeoutMs: number): Promise<RunRecord | undefined> {
    const maxAttempts = 25;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidates = await this.db.select().from(runs).where(eq(runs.status, "queued")).orderBy(sql`${runs.createdAt} ASC`).limit(1);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      const claimed = await this.db.update(runs)
        .set({ status: "claimed", startedAt: now, updatedAt: now, workerId, leaseExpiresAt: addMs(now, leaseTimeoutMs), lastHeartbeatAt: now, leaseAttempt: sql`${runs.leaseAttempt} + 1` })
        .where(and(eq(runs.id, candidate.id), eq(runs.status, "queued")))
        .returning();
      if (claimed[0]) return runFromRow(claimed[0]);
    }
    return undefined;
  }

  async heartbeatRunLease(runId: string, workerId: string, now: string, leaseTimeoutMs: number): Promise<RunRecord | undefined> {
    const terminal: RunStatus[] = ["completed", "pr_created", "failed", "cancelled"];
    const rows = await this.db.update(runs)
      .set({ lastHeartbeatAt: now, leaseExpiresAt: addMs(now, leaseTimeoutMs), updatedAt: now })
      .where(and(eq(runs.id, runId), eq(runs.workerId, workerId), notInArray(runs.status, terminal)))
      .returning();
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  async recoverStaleLeases(now: string, leaseTimeoutMs: number): Promise<RunRecord[]> {
    const inactive: RunStatus[] = ["queued", "completed", "pr_created", "failed", "cancelled"];
    const rows = await this.db.select().from(runs).where(notInArray(runs.status, inactive));
    const changed: RunRecord[] = [];
    for (const row of rows) {
      const run = runFromRow(row);
      if (!isLeaseExpired(run, now, leaseTimeoutMs)) continue;
      const recoverable = run.status === "claimed" || run.status === "preparing";
      const updated: RunRecord = recoverable
        ? clearLease({ ...run, status: "queued", error: "Recovered stale worker lease; requeued before runtime became non-resumable.", updatedAt: now })
        : clearLease({ ...run, status: "failed", error: `Stale worker lease expired while run was ${run.status}; runtime/session resume is not supported for this status.`, finishedAt: now, updatedAt: now });
      await this.upsertRun(updated, pathsFromRun(updated));
      changed.push(updated);
    }
    return changed;
  }

  async listSourceClaims(): Promise<SourceClaim[]> {
    const rows = await this.db.select().from(sourceClaims).orderBy(sql`${sourceClaims.createdAt} DESC`);
    return rows.map(sourceClaimFromRow);
  }

  async tryCreateSourceClaim(input: CreateSourceClaimInput, createdAt: string): Promise<{ claim: SourceClaim; created: boolean }> {
    const claim: SourceClaim = {
      key: input.key,
      provider: input.provider,
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      repoKey: input.repoKey,
      status: "claimed",
      createdAt,
      updatedAt: createdAt,
    };
    const inserted = await this.db.insert(sourceClaims).values(sourceClaimToInsert(claim)).onConflictDoNothing().returning();
    if (inserted[0]) return { claim: sourceClaimFromRow(inserted[0]), created: true };
    const existing = await this.db.select().from(sourceClaims).where(eq(sourceClaims.key, input.key)).limit(1);
    if (!existing[0]) throw new Error(`Source claim disappeared after conflict: ${input.key}`);
    return { claim: sourceClaimFromRow(existing[0]), created: false };
  }

  async updateSourceClaim(claimKey: string, patch: Partial<Omit<SourceClaim, "key" | "createdAt">>, updatedAt: string): Promise<SourceClaim> {
    const existing = await this.db.select().from(sourceClaims).where(eq(sourceClaims.key, claimKey)).limit(1);
    if (!existing[0]) throw new Error(`Source claim not found: ${claimKey}`);
    const current = sourceClaimFromRow(existing[0]);
    if (current.updatedAt > updatedAt) return current;
    const updated: SourceClaim = { ...current, ...patch, updatedAt };
    const rows = await this.db.update(sourceClaims).set(sourceClaimToUpdate(updated)).where(eq(sourceClaims.key, claimKey)).returning();
    if (!rows[0]) throw new Error(`Source claim not found: ${claimKey}`);
    return sourceClaimFromRow(rows[0]);
  }

  async listPullRequests(): Promise<PullRequestRecord[]> {
    const rows = await this.db.select().from(pullRequests).orderBy(sql`${pullRequests.createdAt} DESC`);
    return rows.map(pullRequestFromRow);
  }

  async getPullRequestForRun(runId: string): Promise<PullRequestRecord | undefined> {
    const rows = await this.db.select().from(pullRequests).where(eq(pullRequests.runId, runId)).limit(1);
    return rows[0] ? pullRequestFromRow(rows[0]) : undefined;
  }

  async recordPullRequest(record: PullRequestRecord): Promise<PullRequestRecord> {
    const inserted = await this.db.insert(pullRequests).values(pullRequestToInsert(record)).onConflictDoNothing().returning();
    if (inserted[0]) return pullRequestFromRow(inserted[0]);
    const existing = await this.getPullRequestForRun(record.runId);
    if (!existing) throw new Error(`Pull request disappeared after conflict for run ${record.runId}`);
    return existing;
  }

  async listReviews(): Promise<ReviewRecord[]> {
    const rows = await this.db.select().from(reviews).orderBy(sql`${reviews.createdAt} DESC`);
    return rows.map(reviewFromRow);
  }

  async getReviewForRun(runId: string): Promise<ReviewRecord | undefined> {
    const rows = await this.db.select().from(reviews).where(eq(reviews.runId, runId)).limit(1);
    return rows[0] ? reviewFromRow(rows[0]) : undefined;
  }

  async recordReview(record: ReviewRecord): Promise<ReviewRecord> {
    await this.db.transaction(async (tx) => {
      const savedRows = await tx.insert(reviews)
        .values(reviewToInsert(record))
        .onConflictDoUpdate({
          target: reviews.runId,
          set: {
            status: record.status,
            summary: record.summary,
            findings: record.findings,
            diffStat: record.diffStat ?? null,
            updatedAt: record.updatedAt,
          },
          where: sql`${reviews.updatedAt} <= ${record.updatedAt}`,
        })
        .returning({ id: reviews.id });
      if (savedRows.length === 0) return;
      await tx.delete(reviewFindings).where(eq(reviewFindings.reviewId, record.id));
      if (record.findings.length > 0) {
        await tx.insert(reviewFindings).values(record.findings.map((finding) => ({
          id: `${record.id}:${finding.id}`,
          reviewId: record.id,
          runId: record.runId,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          file: finding.file ?? null,
          line: finding.line ?? null,
          suggestedFix: finding.suggestedFix ?? null,
          createdAt: record.updatedAt,
        })));
      }
    });
    const saved = await this.getReviewForRun(record.runId);
    if (!saved) throw new Error(`Review disappeared after save for run ${record.runId}`);
    return saved;
  }

  async appendControlMessage(runId: string, attemptId: string | undefined, kind: string, payload: Record<string, unknown>, createdAt: string): Promise<void> {
    await this.db.insert(controlMessages).values({
      id: `control-${randomUUID()}`,
      runId,
      attemptId: attemptId ?? null,
      kind,
      payload,
      createdAt,
    });
  }

  async appendEvent(run: RunRecord, data: NormalizedRunEvent, createdAt: string, paths: RunPaths): Promise<StoredRunEvent> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${run.id})::bigint)`);
      const nextRows = await tx
        .select({ sequence: sql<number>`COALESCE(MAX(${runEvents.sequence}), 0)::int + 1` })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id));
      const sequence = nextRows[0]?.sequence ?? 1;
      const stored: StoredRunEvent = {
        version: 1,
        id: `${run.id}-${sequence}`,
        runId: run.id,
        attemptId: run.currentAttemptId,
        sequence,
        type: data.type,
        createdAt,
        data,
      };
      await tx.insert(runEvents).values(storedEventToInsert(stored));
      await upsertEventCheckpoint(tx, run.id, paths, stored, createdAt);
      if (data.type === "attempt_done") {
        await upsertAttemptWithTx(tx, run, data.status, createdAt, createdAt);
      }
      return stored;
    });
  }

  async importLegacyEvent(event: StoredRunEvent, paths: RunPaths): Promise<void> {
    await this.db.insert(runEvents).values(storedEventToInsert(event)).onConflictDoNothing();
    await this.indexEventCheckpoint(event.runId, paths, event, event.sequence, event.createdAt);
  }

  async readEvents(runId: string, afterSequence: number): Promise<StoredRunEvent[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
      .orderBy(runEvents.sequence);
    return rows.map(storedEventFromRow);
  }

  async indexEventCheckpoint(runId: string, paths: RunPaths, event: StoredRunEvent | undefined, lastSequence: number, updatedAt: string): Promise<void> {
    await this.db.insert(eventCheckpoints)
      .values(eventCheckpointToInsert(runId, paths, event, lastSequence, updatedAt))
      .onConflictDoUpdate({
        target: eventCheckpoints.runId,
        set: eventCheckpointToUpdate(paths, event, lastSequence, updatedAt),
        where: sql`${eventCheckpoints.lastSequence} <= ${lastSequence}`,
      });
  }

  private async upsertAttempt(run: RunRecord, status: AttemptStatus): Promise<void> {
    await this.db.insert(attempts)
      .values(attemptToInsert(run, status, run.updatedAt))
      .onConflictDoNothing();
  }

  private async upsertRunArtifacts(run: RunRecord, paths: RunPaths): Promise<void> {
    const artifactRows = artifactRowsForRun(run, paths);
    for (const row of artifactRows) {
      await this.db.insert(artifacts)
        .values(row)
        .onConflictDoUpdate({
          target: artifacts.id,
          set: {
            attemptId: row.attemptId,
            path: row.path,
            sizeBytes: row.sizeBytes,
            sha256: row.sha256,
            contentType: row.contentType,
            redactionState: row.redactionState,
            updatedAt: row.updatedAt,
          },
          where: sql`${artifacts.updatedAt} <= ${row.updatedAt}`,
        });
    }
  }
}

async function upsertAttemptWithTx(
  tx: Parameters<Parameters<NodePgDatabase<typeof tasksmithSchema>["transaction"]>[0]>[0],
  run: RunRecord,
  status: AttemptStatus,
  startedAt: string | undefined,
  finishedAt: string | undefined,
): Promise<void> {
  await tx.insert(attempts)
    .values({
      ...attemptToInsert(run, status, finishedAt ?? startedAt ?? run.updatedAt),
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null,
    })
    .onConflictDoUpdate({
      target: attempts.id,
      set: {
        status,
        startedAt: startedAt ?? null,
        finishedAt: finishedAt ?? null,
        updatedAt: finishedAt ?? startedAt ?? run.updatedAt,
      },
    });
}

async function upsertEventCheckpoint(
  tx: Parameters<Parameters<NodePgDatabase<typeof tasksmithSchema>["transaction"]>[0]>[0],
  runId: string,
  paths: RunPaths,
  event: StoredRunEvent,
  updatedAt: string,
): Promise<void> {
  await tx.insert(eventCheckpoints)
    .values(eventCheckpointToInsert(runId, paths, event, event.sequence, updatedAt))
    .onConflictDoUpdate({
      target: eventCheckpoints.runId,
      set: eventCheckpointToUpdate(paths, event, event.sequence, updatedAt),
      where: sql`${eventCheckpoints.lastSequence} <= ${event.sequence}`,
    });
}

function runToInsert(run: RunRecord, paths: RunPaths): typeof runs.$inferInsert {
  return {
    id: run.id,
    sourceType: run.sourceType,
    sourceKey: run.source?.key ?? null,
    sourceUrl: run.source?.url ?? null,
    title: run.title,
    prompt: run.prompt,
    repoKey: run.repoKey,
    adapter: run.adapter,
    status: run.status,
    currentAttemptId: run.currentAttemptId,
    ciFixAttempts: run.ciFixAttempts,
    reviewFixAttempts: run.reviewFixAttempts,
    claimKey: run.claimKey ?? null,
    runDir: run.runDir,
    workspaceDir: run.workspaceDir,
    sessionId: run.sessionId ?? null,
    sessionFile: run.sessionFile ?? null,
    error: run.error ?? null,
    workerId: run.lease?.workerId ?? null,
    leaseExpiresAt: run.lease?.expiresAt ?? null,
    lastHeartbeatAt: run.lease?.lastHeartbeatAt ?? null,
    leaseAttempt: run.lease?.attempt ?? 0,
    sourceSnapshot: run.source ?? null,
    pullRequest: run.pullRequest ?? null,
    artifactPaths: pathsToArtifactIndex(paths),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  };
}

function runToUpdate(run: RunRecord, paths: RunPaths): Partial<typeof runs.$inferInsert> {
  return {
    sourceType: run.sourceType,
    sourceKey: run.source?.key ?? null,
    sourceUrl: run.source?.url ?? null,
    title: run.title,
    prompt: run.prompt,
    repoKey: run.repoKey,
    adapter: run.adapter,
    status: run.status,
    currentAttemptId: run.currentAttemptId,
    ciFixAttempts: run.ciFixAttempts,
    reviewFixAttempts: run.reviewFixAttempts,
    claimKey: run.claimKey ?? null,
    runDir: run.runDir,
    workspaceDir: run.workspaceDir,
    sessionId: run.sessionId ?? null,
    sessionFile: run.sessionFile ?? null,
    error: run.error ?? null,
    workerId: run.lease?.workerId ?? null,
    leaseExpiresAt: run.lease?.expiresAt ?? null,
    lastHeartbeatAt: run.lease?.lastHeartbeatAt ?? null,
    leaseAttempt: run.lease?.attempt ?? 0,
    sourceSnapshot: run.source ?? null,
    pullRequest: run.pullRequest ?? null,
    artifactPaths: pathsToArtifactIndex(paths),
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    sourceType: row.sourceType as RunSourceType,
    title: row.title,
    prompt: row.prompt,
    repoKey: row.repoKey,
    adapter: row.adapter as RuntimeAdapter,
    ...(row.sourceSnapshot ? { source: row.sourceSnapshot } : {}),
    ...(row.claimKey ? { claimKey: row.claimKey } : {}),
    ...(row.pullRequest ? { pullRequest: row.pullRequest } : {}),
    status: row.status as RunStatus,
    currentAttemptId: row.currentAttemptId,
    ciFixAttempts: row.ciFixAttempts,
    reviewFixAttempts: row.reviewFixAttempts,
    runDir: row.runDir,
    workspaceDir: row.workspaceDir,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.sessionFile ? { sessionFile: row.sessionFile } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.workerId && row.leaseExpiresAt ? { lease: { workerId: row.workerId, expiresAt: row.leaseExpiresAt, ...(row.lastHeartbeatAt ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}), attempt: row.leaseAttempt } } : {}),
  };
}

function sourceClaimToInsert(claim: SourceClaim): typeof sourceClaims.$inferInsert {
  return {
    key: claim.key,
    provider: claim.provider,
    sourceType: claim.sourceType,
    sourceKey: claim.sourceKey,
    sourceUrl: claim.sourceUrl ?? null,
    repoKey: claim.repoKey,
    runId: claim.runId ?? null,
    status: claim.status,
    error: claim.error ?? null,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

function sourceClaimToUpdate(claim: SourceClaim): Partial<typeof sourceClaims.$inferInsert> {
  return {
    provider: claim.provider,
    sourceType: claim.sourceType,
    sourceKey: claim.sourceKey,
    sourceUrl: claim.sourceUrl ?? null,
    repoKey: claim.repoKey,
    runId: claim.runId ?? null,
    status: claim.status,
    error: claim.error ?? null,
    updatedAt: claim.updatedAt,
  };
}

function sourceClaimFromRow(row: SourceClaimRow): SourceClaim {
  return {
    key: row.key,
    provider: row.provider as SourceClaim["provider"],
    sourceType: row.sourceType as Exclude<RunSourceType, "manual">,
    sourceKey: row.sourceKey,
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    repoKey: row.repoKey,
    ...(row.runId ? { runId: row.runId } : {}),
    status: row.status as SourceClaimStatus,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function pullRequestToInsert(record: PullRequestRecord): typeof pullRequests.$inferInsert {
  return {
    id: record.id,
    runId: record.runId,
    provider: record.provider,
    url: record.url,
    number: record.number ?? null,
    branch: record.branch,
    baseBranch: record.baseBranch,
    title: record.title,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function pullRequestFromRow(row: PullRequestRow): PullRequestRecord {
  return {
    id: row.id,
    runId: row.runId,
    provider: row.provider as PullRequestRecord["provider"],
    url: row.url,
    ...(row.number === null ? {} : { number: row.number }),
    branch: row.branch,
    baseBranch: row.baseBranch,
    title: row.title,
    body: row.body,
    status: row.status as PullRequestRecord["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reviewToInsert(record: ReviewRecord): typeof reviews.$inferInsert {
  return {
    id: record.id,
    runId: record.runId,
    status: record.status,
    summary: record.summary,
    findings: record.findings,
    diffStat: record.diffStat ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function reviewFromRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    runId: row.runId,
    status: row.status as ReviewRecord["status"],
    summary: row.summary,
    findings: row.findings,
    ...(row.diffStat ? { diffStat: row.diffStat } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function storedEventToInsert(event: StoredRunEvent): typeof runEvents.$inferInsert {
  return {
    id: event.id,
    runId: event.runId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    type: event.type,
    payload: event.data,
    createdAt: event.createdAt,
  };
}

function storedEventFromRow(row: RunEventRow): StoredRunEvent {
  return {
    version: 1,
    id: row.id,
    runId: row.runId,
    attemptId: row.attemptId,
    sequence: row.sequence,
    type: row.type as NormalizedRunEvent["type"],
    createdAt: row.createdAt,
    data: row.payload,
  };
}

function attemptToInsert(run: RunRecord, status: AttemptStatus, updatedAt: string): typeof attempts.$inferInsert {
  return {
    id: attemptPrimaryId(run.id, run.currentAttemptId),
    runId: run.id,
    attemptId: run.currentAttemptId,
    adapter: run.adapter,
    status,
    createdAt: run.createdAt,
    updatedAt,
  };
}

function artifactRowsForRun(run: RunRecord, paths: RunPaths): Array<typeof artifacts.$inferInsert> {
  const base = { runId: run.id, attemptId: null, redactionState: "path_only", createdAt: run.createdAt, updatedAt: run.updatedAt };
  return [
    { ...base, id: artifactId(run.id, "run_dir"), kind: "run_dir", path: paths.runDir },
    { ...base, id: artifactId(run.id, "workspace"), kind: "workspace", path: paths.workspaceDir },
    { ...base, id: artifactId(run.id, "home"), kind: "home", path: paths.homeDir },
    { ...base, id: artifactId(run.id, "pi_agent_dir"), kind: "pi_agent_dir", path: paths.agentDir },
    { ...base, id: artifactId(run.id, "pi_session_dir"), kind: "pi_session_dir", path: paths.sessionDir },
    { ...base, id: artifactId(run.id, "events_dir"), kind: "events_dir", path: paths.eventsDir },
    { ...base, id: artifactId(run.id, "pi_raw_events"), kind: "pi_raw_events", path: paths.rawEventsPath, contentType: "application/x-ndjson" },
    { ...base, id: artifactId(run.id, "control_events_legacy_jsonl"), kind: "control_events_legacy_jsonl", path: paths.controlEventsPath, contentType: "application/x-ndjson" },
    { ...base, id: artifactId(run.id, "tasksmith_events_legacy_jsonl"), kind: "tasksmith_events_legacy_jsonl", path: paths.normalizedEventsPath, contentType: "application/x-ndjson" },
    { ...base, id: artifactId(run.id, "logs_dir"), kind: "logs_dir", path: paths.logsDir },
    { ...base, id: artifactId(run.id, "artifacts_dir"), kind: "artifacts_dir", path: paths.artifactsDir },
    { ...base, id: artifactId(run.id, "metadata_json"), kind: "metadata_json", path: paths.metadataPath, contentType: "application/json" },
  ];
}

function eventCheckpointToInsert(runId: string, paths: RunPaths, event: StoredRunEvent | undefined, lastSequence: number, updatedAt: string): typeof eventCheckpoints.$inferInsert {
  return {
    runId,
    normalizedEventsPath: null,
    rawEventsPath: paths.rawEventsPath,
    controlEventsPath: paths.controlEventsPath,
    lastSequence,
    lastEventId: event?.id ?? null,
    lastEventType: event?.type ?? null,
    lastEventCreatedAt: event?.createdAt ?? null,
    updatedAt,
  };
}

function eventCheckpointToUpdate(paths: RunPaths, event: StoredRunEvent | undefined, lastSequence: number, updatedAt: string): Partial<typeof eventCheckpoints.$inferInsert> {
  return {
    normalizedEventsPath: null,
    rawEventsPath: paths.rawEventsPath,
    controlEventsPath: paths.controlEventsPath,
    lastSequence,
    lastEventId: event?.id ?? null,
    lastEventType: event?.type ?? null,
    lastEventCreatedAt: event?.createdAt ?? null,
    updatedAt,
  };
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function isLeaseExpired(run: RunRecord, now: string, leaseTimeoutMs: number): boolean {
  if (!run.lease) return false;
  const expiresAt = run.lease.expiresAt ?? (run.lease.lastHeartbeatAt ? addMs(run.lease.lastHeartbeatAt, leaseTimeoutMs) : undefined);
  return expiresAt ? expiresAt <= now : false;
}

function clearLease(run: RunRecord): RunRecord {
  const { lease: _lease, ...rest } = run;
  return rest;
}

function pathsToArtifactIndex(paths: RunPaths): Record<string, string> {
  return {
    runDir: paths.runDir,
    workspaceDir: paths.workspaceDir,
    homeDir: paths.homeDir,
    sessionDir: paths.sessionDir,
    eventsDir: paths.eventsDir,
    rawEventsPath: paths.rawEventsPath,
    logsDir: paths.logsDir,
    artifactsDir: paths.artifactsDir,
    metadataPath: paths.metadataPath,
  };
}

function pathsFromRun(run: RunRecord): RunPaths {
  const runDir = run.runDir;
  const workspaceDir = run.workspaceDir;
  const homeDir = `${runDir}/home`;
  const agentDir = `${homeDir}/.pi/agent`;
  const eventsDir = `${runDir}/events`;
  return {
    runDir,
    workspaceDir,
    homeDir,
    agentDir,
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    settingsPath: `${agentDir}/settings.json`,
    sessionDir: `${runDir}/pi-session`,
    eventsDir,
    rawEventsPath: `${eventsDir}/pi-raw.jsonl`,
    normalizedEventsPath: `${eventsDir}/tasksmith-events.jsonl`,
    controlEventsPath: `${eventsDir}/controls.jsonl`,
    logsDir: `${runDir}/logs`,
    artifactsDir: `${runDir}/artifacts`,
    metadataPath: `${runDir}/metadata.json`,
  };
}

function artifactId(runId: string, kind: string): string {
  return `${runId}:${kind}`;
}

function attemptPrimaryId(runId: string, attemptId: string): string {
  return `${runId}:${attemptId}`;
}
