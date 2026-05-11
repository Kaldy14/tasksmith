import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { NormalizedRunEvent, PullRequestSummary, ReviewFinding, RunSourceSnapshot } from "../domain/types.js";

export const schemaMigrations = pgTable("tasksmith_schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const runs = pgTable("tasksmith_runs", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key"),
  sourceUrl: text("source_url"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  repoKey: text("repo_key").notNull(),
  adapter: text("adapter").notNull(),
  status: text("status").notNull(),
  currentAttemptId: text("current_attempt_id").notNull(),
  claimKey: text("claim_key"),
  runDir: text("run_dir").notNull(),
  workspaceDir: text("workspace_dir").notNull(),
  sessionId: text("session_id"),
  sessionFile: text("session_file"),
  error: text("error"),
  sourceSnapshot: jsonb("source_snapshot").$type<RunSourceSnapshot>(),
  pullRequest: jsonb("pull_request").$type<PullRequestSummary>(),
  artifactPaths: jsonb("artifact_paths").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
}, (table) => [
  index("tasksmith_runs_status_idx").on(table.status),
  index("tasksmith_runs_repo_status_idx").on(table.repoKey, table.status),
  index("tasksmith_runs_source_idx").on(table.sourceType, table.sourceKey),
  index("tasksmith_runs_updated_idx").on(table.updatedAt),
]);

export const attempts = pgTable("tasksmith_attempts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  adapter: text("adapter").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  uniqueIndex("tasksmith_attempts_run_attempt_idx").on(table.runId, table.attemptId),
  index("tasksmith_attempts_run_idx").on(table.runId),
  index("tasksmith_attempts_status_idx").on(table.status),
]);

export const sourceClaims = pgTable("tasksmith_source_claims", {
  key: text("key").primaryKey(),
  provider: text("provider").notNull(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key").notNull(),
  sourceUrl: text("source_url"),
  repoKey: text("repo_key").notNull(),
  runId: text("run_id"),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_source_claims_run_idx").on(table.runId),
  index("tasksmith_source_claims_source_idx").on(table.provider, table.sourceKey),
]);

export const pullRequests = pgTable("tasksmith_pull_requests", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  provider: text("provider").notNull(),
  url: text("url").notNull(),
  number: integer("number"),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_pull_requests_status_idx").on(table.status),
]);

export const reviews = pgTable("tasksmith_reviews", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  findings: jsonb("findings").$type<ReviewFinding[]>().notNull().default([]),
  diffStat: text("diff_stat"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_reviews_status_idx").on(table.status),
]);

export const reviewFindings = pgTable("tasksmith_review_findings", {
  id: text("id").primaryKey(),
  reviewId: text("review_id").notNull(),
  runId: text("run_id").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  file: text("file"),
  line: integer("line"),
  suggestedFix: text("suggested_fix"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_review_findings_run_idx").on(table.runId),
  index("tasksmith_review_findings_severity_idx").on(table.severity),
]);

export const runEvents = pgTable("tasksmith_run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<NormalizedRunEvent>().notNull(),
  artifactId: text("artifact_id"),
  rawRef: jsonb("raw_ref").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  uniqueIndex("tasksmith_run_events_run_sequence_idx").on(table.runId, table.sequence),
  index("tasksmith_run_events_run_created_idx").on(table.runId, table.createdAt),
  index("tasksmith_run_events_type_idx").on(table.type),
]);

export const controlMessages = pgTable("tasksmith_control_messages", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_control_messages_run_idx").on(table.runId),
]);

export const artifacts = pgTable("tasksmith_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id"),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  sizeBytes: integer("size_bytes"),
  sha256: text("sha256"),
  contentType: text("content_type"),
  redactionState: text("redaction_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table) => [
  index("tasksmith_artifacts_run_idx").on(table.runId),
  index("tasksmith_artifacts_kind_idx").on(table.kind),
]);

export const eventCheckpoints = pgTable("tasksmith_event_checkpoints", {
  runId: text("run_id").primaryKey(),
  normalizedEventsPath: text("normalized_events_path"),
  rawEventsPath: text("raw_events_path").notNull(),
  controlEventsPath: text("control_events_path").notNull(),
  lastSequence: integer("last_sequence").notNull().default(0),
  lastEventId: text("last_event_id"),
  lastEventType: text("last_event_type"),
  lastEventCreatedAt: timestamp("last_event_created_at", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const tasksmithSchema = {
  schemaMigrations,
  runs,
  attempts,
  sourceClaims,
  pullRequests,
  reviews,
  reviewFindings,
  runEvents,
  controlMessages,
  artifacts,
  eventCheckpoints,
};
