# Architecture

## Desired system shape

```txt
Jira
  -> TaskSmith API/Orchestrator
  -> Run Queue
  -> Worker
  -> Sandbox + Pi Session
  -> Event Store
  -> Web UI
  -> Verifier
  -> Reviewer
  -> PR Creator
  -> Jira Updater
```

TaskSmith should be built around **Runs** and **Events**, not around raw agent processes.

## High-level flow

```txt
1. Jira issue receives label/status indicating AI readiness.
2. Jira Poller finds issue via JQL.
3. Orchestrator acquires idempotent claim.
4. Orchestrator creates Run and enqueues work.
5. Worker resolves repository and base branch.
6. Worker creates sandbox/worktree.
7. Worker starts native Pi session.
8. Pi events are stored and streamed to UI.
9. Human may steer/follow-up/abort from UI.
10. Agent finishes implementation attempt.
11. Verifier runs deterministic checks.
12. If checks fail, worker starts a fix attempt with logs.
13. Reviewer performs fresh-context diff review.
14. PR Creator opens draft PR.
15. Jira Updater comments/transitions issue.
```

## Component diagram

```txt
                     ┌────────────────────┐
                     │        Jira         │
                     └─────────┬──────────┘
                               │ JQL/API
                               ▼
┌──────────────┐      ┌────────────────────┐      ┌──────────────┐
│   Web UI     │◀────▶│ TaskSmith API       │─────▶│  Run Queue   │
│ runs/chat    │ WS   │ Orchestrator        │      │ Redis/BullMQ │
└──────────────┘      └─────────┬──────────┘      └──────┬───────┘
                                │                         │
                                ▼                         ▼
                       ┌─────────────────┐       ┌────────────────┐
                       │ Postgres         │◀──────│ Worker          │
                       │ runs/events/etc. │       │ Pi runtime      │
                       └─────────────────┘       └───────┬────────┘
                                                          │
                                                          ▼
                                                 ┌────────────────┐
                                                 │ Sandbox/workdir │
                                                 │ repo + Pi sess. │
                                                 └────────────────┘
```

## Core services

### API Service

Responsibilities:

- authenticate internal users,
- expose run list/detail APIs,
- expose WebSocket run stream,
- accept user control messages,
- provide admin configuration APIs,
- write events to event store.

### Jira Poller

Responsibilities:

- periodically run configured JQL queries,
- claim issues idempotently,
- create Runs,
- transition/comment Jira issues according to configured workflow.

The poller must not run inside the agent sandbox.

### Orchestrator

Responsibilities:

- own the Run state machine,
- enqueue attempts,
- decide when to verify/review/create PR,
- retry or stop on failures,
- maintain correspondence between Jira issue, Run, attempts, PR.

### Worker

Responsibilities:

- execute queued attempts,
- create sandbox/worktree,
- start Pi runtime,
- stream raw and normalized events,
- handle control commands forwarded by API,
- produce terminal attempt result.

### Pi Adapter

Responsibilities:

- start or resume Pi sessions,
- translate TaskSmith control commands into Pi SDK/RPC calls,
- normalize Pi events into TaskSmith events,
- preserve raw Pi events for audit/debugging.

### Verifier

Responsibilities:

- run deterministic project commands outside the LLM decision loop,
- capture stdout/stderr/artifacts,
- emit structured verification results,
- trigger fix attempts when configured.

### Reviewer

Responsibilities:

- run a fresh-context review against the final diff,
- classify findings by severity,
- optionally ask implementation agent to fix trivial findings,
- block PR creation on severe findings according to policy.

### PR Creator

Responsibilities:

- create branch,
- commit changes,
- push branch,
- create draft PR/MR,
- attach verification/review summary.

### Jira Updater

Responsibilities:

- add status comments,
- link PR,
- transition issue status,
- add/remove labels,
- report failures with concise logs.

## State model

### Run states

```txt
queued
claimed
preparing
running
waiting_for_user
verifying
fixing
reviewing
creating_pr
pr_created
failed
cancelled
```

### Attempt states

```txt
queued
starting
streaming
completed
failed
aborted
```

### Verification states

```txt
pending
running
passed
failed
skipped
```

## Suggested database entities

### `runs`

- `id`
- `source_type` — `jira`, `manual`, future `github_issue`
- `source_key` — e.g. `VOS-123`
- `repo_key`
- `base_branch`
- `status`
- `current_attempt_id`
- `created_at`
- `updated_at`

### `jira_claims`

- `jira_key`
- `run_id`
- `claim_status`
- `claimed_at`
- unique `jira_key`

### `attempts`

- `id`
- `run_id`
- `agent_adapter` — initial value `pi`
- `sandbox_id`
- `status`
- `started_at`
- `finished_at`

### `events`

- `id`
- `run_id`
- `attempt_id`
- `sequence`
- `type`
- `role`
- `content`
- `raw_json`
- `created_at`

### `verification_results`

- `id`
- `run_id`
- `command`
- `exit_code`
- `stdout_ref`
- `stderr_ref`
- `status`
- `created_at`

### `pull_requests`

- `id`
- `run_id`
- `provider`
- `url`
- `number`
- `branch`
- `status`

## Configuration model

Repository configuration should be explicit.

Example:

```yaml
repos:
  vosime-admin:
    gitUrl: git@github.com:org/vosime-admin.git
    defaultBranch: main
    verify:
      - name: typecheck
        command: pnpm typecheck
      - name: lint
        command: pnpm lint
      - name: test
        command: pnpm test
      - name: e2e
        command: pnpm e2e

  core-hub:
    gitUrl: git@github.com:org/core-hub.git
    defaultBranch: main
    verify:
      - name: test
        command: pnpm test
```

## Design principles

- Backend controls Jira and Git provider APIs.
- Agent works only inside sandbox/worktree.
- UI reads persisted events, not raw process stdout.
- Human control messages are stored as events before delivery.
- Verification is deterministic and outside agent autonomy.
- Review uses fresh context.
