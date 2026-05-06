# Agent Brief: TaskSmith MVP

**Category:** enhancement  
**Summary:** Build the smallest end-to-end TaskSmith flow: manual Pi run with live UI stream, deterministic verifier, and persisted events.

## Current behavior

The repository currently contains documentation only. There is no application code.

## Desired behavior

A user can create a manual Run against a configured repository and prompt. TaskSmith starts a Pi session, streams events to a web UI, allows steer/follow-up/abort, stores all events, and runs configured verification commands after the agent completes.

Jira and PR creation are intentionally deferred until the manual run loop works.

## Key interfaces

### Run

Represents top-level work.

Required fields:

- `id`
- `sourceType`
- `sourceKey`
- `repoKey`
- `status`
- `createdAt`
- `updatedAt`

### Attempt

Represents one Pi execution attempt.

Required fields:

- `id`
- `runId`
- `adapter`
- `status`
- `startedAt`
- `finishedAt`

### Event

Append-only event record.

Required fields:

- `id`
- `runId`
- `attemptId`
- `sequence`
- `type`
- `payload`
- `createdAt`

### PiAdapter

Expected capabilities:

- start session,
- send prompt,
- steer,
- follow-up,
- abort,
- subscribe to events.

## Acceptance criteria

- [ ] User can create a manual Run through API or minimal UI.
- [ ] Worker creates isolated workspace for the Run.
- [ ] Pi starts with per-run session directory.
- [ ] Pi events are persisted.
- [ ] UI displays live event stream.
- [ ] UI reconnects and replays history.
- [ ] User can send steer/follow-up/abort.
- [ ] Verifier runs configured command after Pi completes.
- [ ] Verification result appears in UI.
- [ ] Documentation is updated for any changed architecture.

## Out of scope

- Jira polling.
- PR creation.
- CI fixup.
- Multi-agent provider support.
- Complex RBAC.
- Auto-merge.
