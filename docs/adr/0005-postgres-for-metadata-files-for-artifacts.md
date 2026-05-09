# ADR 0005: Use Postgres for metadata indexes while keeping Pi sessions and artifacts on disk

## Status

Accepted

## Context

TaskSmith now needs a durable database for authentication and future multi-worker coordination, but Pi already writes useful session/chat artifacts as files. The run UI also relies on append-only JSONL event replay. Re-modeling raw Pi chat/session files into relational tables would add risk and couple TaskSmith to Pi internals before the product workflow is stable.

## Decision

TaskSmith will introduce Postgres as an operational metadata/index store, not as the source of truth for raw Pi transcripts or large artifacts.

TaskSmith communicates with Postgres through Drizzle ORM. Postgres stores indexed metadata such as:

- Runs: id, source, repo, status, attempt id, timestamps, workspace/artifact paths.
- Source claims: unique claim keys, source keys, associated run ids, claim status.
- Pull request records.
- Review records and structured findings.
- Event checkpoints and file pointers for normalized/raw/control event JSONL files.
- Future Better Auth user/session/account/verification tables, managed by Better Auth migrations.

The filesystem remains the source of truth for:

- Pi session/chat files.
- Raw Pi event JSONL.
- Normalized TaskSmith event JSONL.
- Control JSONL.
- Verifier/reviewer logs and artifacts.
- Per-run workspace and home/session directories.

The current file store remains the primary runtime store during this transition. When `TASKSMITH_DATABASE_URL` is configured, TaskSmith mirrors metadata into Postgres and syncs existing file-backed state at boot.

## Consequences

Positive:

- Better Auth can be added on a real database without disrupting Pi session files.
- Operators can query run/source/PR/review metadata in SQL.
- Run artifacts remain easy to inspect over SSH and are not forced into relational rows.
- A later migration can move operational state reads/writes to Postgres incrementally.

Negative:

- For now, there are two persistence surfaces: file-backed primary state and Postgres indexes.
- If Postgres indexing fails after a file write, the index can lag until the next sync.
- Multi-process workers still require a later queue/store hardening slice; Postgres metadata alone does not make the current `FileStore` multi-writer safe.

## Acceptance criteria

- [x] `TASKSMITH_DATABASE_URL` enables Postgres metadata migrations.
- [x] App startup syncs file-backed run/claim/PR/review state into Postgres.
- [x] New run, claim, event checkpoint, review, and PR metadata are mirrored into Postgres.
- [x] Pi session/chat files and event JSONL remain on disk and are referenced by path.
- [x] Dockerized Postgres deployment is documented for the dedicated TaskSmith host.
