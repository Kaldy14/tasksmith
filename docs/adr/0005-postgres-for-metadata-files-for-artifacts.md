# ADR 0005: Use Postgres for TaskSmith app state and keep Pi transcripts/artifacts on disk

## Status

Accepted

## Context

TaskSmith needs a durable database for authentication, source-claim uniqueness, run state, live UI replay, and future queue/worker coordination. Pi already writes useful native session/chat artifacts as files. Re-modeling raw Pi chat/session files into relational tables would add risk and couple TaskSmith to Pi internals.

## Decision

TaskSmith will use Postgres, accessed through Drizzle ORM, as the authoritative store for app state and normalized product events when `TASKSMITH_DATABASE_URL` is configured.

Postgres stores:

- Runs: id, source, prompt/title, repo, adapter, status, current attempt, timestamps, workspace/artifact paths.
- Attempts: run attempt ids, adapter, status, start/finish timestamps.
- Source claims: unique claim keys, source keys, associated run ids, claim status.
- Normalized TaskSmith run events for UI replay and WebSocket reconnect.
- Control messages from humans/operators.
- Pull request records.
- Review records and structured findings.
- Artifact rows and file pointers.
- Future Better Auth user/session/account/verification tables, managed by Better Auth migrations.

The filesystem remains authoritative for large/raw/provider-native artifacts:

- Pi session/chat files.
- Raw Pi event JSONL.
- Verifier/reviewer logs, patches, screenshots, traces, and other artifacts.
- Per-run workspace and home/session directories.
- Legacy normalized/control JSONL from pre-Postgres runs.

Postgres may contain normalized user-visible assistant/tool/message text, because that is TaskSmith's product event model. It must not store full raw Pi provider transcript structures. Debug/raw transcript views should read the Pi session/raw-event artifact files on demand.

Local/test deployments may omit `TASKSMITH_DATABASE_URL`; in that mode TaskSmith falls back to the legacy file store. Production/internal deployments should use Postgres as the app-state store.

## Consequences

Positive:

- Better Auth can be added on the same database foundation.
- UI replay no longer depends on parsing JSONL in production mode.
- Source claims use database uniqueness semantics.
- Operators can query run/source/event/review/PR metadata in SQL.
- Pi transcripts remain inspectable and are not copied wholesale into DB rows.

Negative:

- There are still two persistence surfaces: Postgres for app state, filesystem for artifacts.
- DB availability is required when `TASKSMITH_DATABASE_URL` is configured.
- Multi-process workers still need a real queue/lease model; Postgres app state is necessary but not sufficient for safe horizontal workers.
- Same-UID Pi/tool execution remains a hardening gap for high-value secrets until workers run under restricted users/containers.

## Acceptance criteria

- [x] `TASKSMITH_DATABASE_URL` enables Drizzle/Postgres migrations.
- [x] Existing file-backed state is imported into Postgres at startup.
- [x] New runs, attempts, source claims, normalized events, controls, reviews, findings, PRs, and artifact pointers are written to Postgres.
- [x] UI/API reads run state and normalized events from Postgres in DB mode.
- [x] Pi session/chat files and raw Pi event JSONL remain on disk and are referenced by artifact paths.
- [x] Dockerized Postgres deployment is documented for the dedicated TaskSmith host.
