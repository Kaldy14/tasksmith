# TaskSmith

TaskSmith is a proposed internal autonomous coding-agent platform for turning issue-tracker work into verified pull requests.

The name means: **take a task, forge a high-quality code change, and hand back a reviewable PR.**

## Mission

Build a self-hosted, Pi-first coding-agent control plane that:

1. Runs on a Hetzner server.
2. Picks up tagged Jira issues.
3. Creates isolated coding runs against configured repositories.
4. Streams the live agent session to a web UI.
5. Allows humans to steer, follow up, pause, or abort the agent.
6. Runs deterministic verification, including e2e where configured.
7. Performs independent review.
8. Creates PRs and updates Jira.

## Core direction

TaskSmith should be **Pi-first**, not Codex-first.

Pi gives the product shape we want:

- live event streaming,
- session persistence,
- steering messages,
- follow-up messages,
- abort/retry controls,
- native SDK/RPC integration,
- custom UI integration.

Codex may be added later as a secondary turn-based adapter, but it is not part of the initial architecture.

## Read order for future LLM agents

When starting work in this repository, read these files first:

1. [`AGENTS.md`](./AGENTS.md) — operating rules for agents.
2. [`docs/CONTEXT.md`](./docs/CONTEXT.md) — durable product context.
3. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — proposed system architecture.
4. [`docs/PI-FIRST-RUNTIME.md`](./docs/PI-FIRST-RUNTIME.md) — Pi runtime design.
5. [`docs/JIRA-WORKFLOW.md`](./docs/JIRA-WORKFLOW.md) — Jira pickup and state sync.
6. [`docs/TRACKER.md`](./docs/TRACKER.md) — detailed milestone tracker and next actions.
7. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — short roadmap view.
8. ADRs in [`docs/adr`](./docs/adr).

## Documentation map

- [`docs/CONTEXT.md`](./docs/CONTEXT.md) — goals, constraints, non-goals, terminology.
- [`docs/RESEARCH-SUMMARY.md`](./docs/RESEARCH-SUMMARY.md) — research findings from Kandev, CodeForge, OpenHands, Sandcastle, Open Agents, Pi.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — components and data flow.
- [`docs/PI-FIRST-RUNTIME.md`](./docs/PI-FIRST-RUNTIME.md) — how TaskSmith should use Pi differently from Kandev.
- [`docs/JIRA-WORKFLOW.md`](./docs/JIRA-WORKFLOW.md) — issue claiming and Jira updates.
- [`docs/EVENTS-AND-UI.md`](./docs/EVENTS-AND-UI.md) — live event stream, chat, and control model.
- [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) — personal/work instance config, repositories, GitHub Issues/Jira source metadata, verification profiles.
- [`docs/SANDCASTLE-FLOW.md`](./docs/SANDCASTLE-FLOW.md) — Sandcastle-inspired single-task plan/implement/review/fix/deliver workflow.
- [`docs/SECURITY.md`](./docs/SECURITY.md) — sandboxing, secrets, threat model.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — short roadmap view.
- [`docs/TRACKER.md`](./docs/TRACKER.md) — detailed milestone tracker, exit gates, backlog, and current status.
- [`docs/REFERENCES.md`](./docs/REFERENCES.md) — external repositories, source links, commands.
- [`docs/adr`](./docs/adr) — durable architecture decisions.
- [`docs/briefs`](./docs/briefs) — future implementation handoff briefs.

## Current status

Manual Run, deterministic verification, GitHub/Jira source pickup, fresh-context review, and ready-to-review GitHub PR delivery foundations are implemented. The repository includes:

- a standalone Pi SDK runtime spike harness,
- a Node/TypeScript API server,
- a browser UI for manual Runs,
- persistent event JSONL replay,
- WebSocket live event streaming,
- browser controls for steer/follow-up/abort,
- configured repository/source metadata,
- a GitHub Issues/Jira poll endpoint with file-backed idempotent claims,
- deterministic verifier events and redacted logs,
- fresh-context diff review with structured findings and blocking severe findings,
- ready-to-review GitHub PR creation or explicit `squash_merge_main` direct delivery after verification/review for configured repositories,
- Postgres app-state storage via `TASKSMITH_DATABASE_URL` while Pi chats, raw events, logs, workspaces, and large artifacts remain file-backed,
- optional Better Auth email/password protection for UI/API/WebSocket control surfaces via `TASKSMITH_AUTH_ENABLED=1`.

See:

- [`docs/PI-RUNTIME-SPIKE.md`](./docs/PI-RUNTIME-SPIKE.md)
- [`docs/MANUAL-RUN-MVP.md`](./docs/MANUAL-RUN-MVP.md)

Verification:

```bash
pnpm typecheck
pnpm typecheck:web
pnpm build
pnpm e2e:manual-run
pnpm e2e:verifier
pnpm e2e:source-pickup
pnpm e2e:delivery
pnpm e2e:config-init
pnpm e2e:review
pnpm e2e:pi-spike
pnpm e2e:postgres-index   # skips unless TASKSMITH_TEST_DATABASE_URL is set
pnpm e2e:auth             # skips unless TASKSMITH_TEST_DATABASE_URL is set
TASKSMITH_REAL_PI_E2E=1 pnpm e2e:pi-spike
```
