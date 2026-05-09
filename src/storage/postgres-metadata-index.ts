import { eq, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { PullRequestRecord, ReviewRecord, RunPaths, RunRecord, SourceClaim, StoredRunEvent } from "../domain/types.js";
import { eventCheckpoints, pullRequests, reviews, runs, schemaMigrations, sourceClaims, tasksmithSchema } from "./postgres-schema.js";

interface Migration {
  version: number;
  name: string;
  statements: readonly SQL[];
}

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

  async indexRun(run: RunRecord, paths: RunPaths): Promise<void> {
    await this.db.insert(runs)
      .values({
        id: run.id,
        sourceType: run.sourceType,
        sourceKey: run.source?.key ?? null,
        sourceUrl: run.source?.url ?? null,
        title: run.title,
        repoKey: run.repoKey,
        adapter: run.adapter,
        status: run.status,
        currentAttemptId: run.currentAttemptId,
        claimKey: run.claimKey ?? null,
        runDir: run.runDir,
        workspaceDir: run.workspaceDir,
        sessionId: run.sessionId ?? null,
        sessionFile: run.sessionFile ?? null,
        error: run.error ?? null,
        sourceSnapshot: run.source ?? null,
        pullRequest: run.pullRequest ?? null,
        artifactPaths: pathsToArtifactIndex(paths),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
      })
      .onConflictDoUpdate({
        target: runs.id,
        set: {
          sourceType: run.sourceType,
          sourceKey: run.source?.key ?? null,
          sourceUrl: run.source?.url ?? null,
          title: run.title,
          repoKey: run.repoKey,
          adapter: run.adapter,
          status: run.status,
          currentAttemptId: run.currentAttemptId,
          claimKey: run.claimKey ?? null,
          runDir: run.runDir,
          workspaceDir: run.workspaceDir,
          sessionId: run.sessionId ?? null,
          sessionFile: run.sessionFile ?? null,
          error: run.error ?? null,
          sourceSnapshot: run.source ?? null,
          pullRequest: run.pullRequest ?? null,
          artifactPaths: pathsToArtifactIndex(paths),
          updatedAt: run.updatedAt,
          startedAt: run.startedAt ?? null,
          finishedAt: run.finishedAt ?? null,
        },
        where: sql`${runs.updatedAt} <= ${run.updatedAt}`,
      });
  }

  async indexSourceClaim(claim: SourceClaim): Promise<void> {
    await this.db.insert(sourceClaims)
      .values({
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
      })
      .onConflictDoUpdate({
        target: sourceClaims.key,
        set: {
          provider: claim.provider,
          sourceType: claim.sourceType,
          sourceKey: claim.sourceKey,
          sourceUrl: claim.sourceUrl ?? null,
          repoKey: claim.repoKey,
          runId: claim.runId ?? null,
          status: claim.status,
          error: claim.error ?? null,
          updatedAt: claim.updatedAt,
        },
        where: sql`${sourceClaims.updatedAt} <= ${claim.updatedAt}`,
      });
  }

  async indexPullRequest(record: PullRequestRecord): Promise<void> {
    await this.db.insert(pullRequests)
      .values({
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
      })
      .onConflictDoUpdate({
        target: pullRequests.runId,
        set: {
          provider: record.provider,
          url: record.url,
          number: record.number ?? null,
          branch: record.branch,
          baseBranch: record.baseBranch,
          title: record.title,
          body: record.body,
          status: record.status,
          updatedAt: record.updatedAt,
        },
        where: sql`${pullRequests.updatedAt} <= ${record.updatedAt}`,
      });
  }

  async indexReview(record: ReviewRecord): Promise<void> {
    await this.db.insert(reviews)
      .values({
        id: record.id,
        runId: record.runId,
        status: record.status,
        summary: record.summary,
        findings: record.findings,
        diffStat: record.diffStat ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
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
      });
  }

  async indexEventCheckpoint(runId: string, paths: RunPaths, event: StoredRunEvent | undefined, lastSequence: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(eventCheckpoints)
      .values({
        runId,
        normalizedEventsPath: paths.normalizedEventsPath,
        rawEventsPath: paths.rawEventsPath,
        controlEventsPath: paths.controlEventsPath,
        lastSequence,
        lastEventId: event?.id ?? null,
        lastEventType: event?.type ?? null,
        lastEventCreatedAt: event?.createdAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: eventCheckpoints.runId,
        set: {
          normalizedEventsPath: paths.normalizedEventsPath,
          rawEventsPath: paths.rawEventsPath,
          controlEventsPath: paths.controlEventsPath,
          lastSequence,
          lastEventId: event?.id ?? null,
          lastEventType: event?.type ?? null,
          lastEventCreatedAt: event?.createdAt ?? null,
          updatedAt: now,
        },
        where: sql`${eventCheckpoints.lastSequence} <= ${lastSequence} AND (${eventCheckpoints.lastEventCreatedAt} IS NULL OR ${eventCheckpoints.lastEventCreatedAt} <= ${event?.createdAt ?? now})`,
      });
  }
}

function pathsToArtifactIndex(paths: RunPaths): Record<string, string> {
  return {
    runDir: paths.runDir,
    workspaceDir: paths.workspaceDir,
    homeDir: paths.homeDir,
    sessionDir: paths.sessionDir,
    eventsDir: paths.eventsDir,
    normalizedEventsPath: paths.normalizedEventsPath,
    rawEventsPath: paths.rawEventsPath,
    controlEventsPath: paths.controlEventsPath,
    logsDir: paths.logsDir,
    artifactsDir: paths.artifactsDir,
    metadataPath: paths.metadataPath,
  };
}
