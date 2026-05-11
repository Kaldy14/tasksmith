# Manual Run MVP

## Status

Phase 2 initial vertical slice is implemented locally.

This slice turns the Phase 1 Pi runtime contract into a browser-visible manual Run experience. It is still pre-Jira and pre-PR, but it is a working control plane surface: API, WebSocket stream, persistent event replay, and browser controls.

## What is included

- Node/TypeScript HTTP server in `src/server`.
- React/TanStack Router browser UI in `src/web`, built by Vite into `dist/web` for the Node server to serve.
- Postgres-backed app state and normalized events when `TASKSMITH_DATABASE_URL` is set; legacy file-backed mode for local tests without DB.
- Manual Run creation.
- Runtime adapters:
  - `demo` for deterministic UI/e2e without model auth,
  - `pi` for real Pi SDK sessions using narrow auth material.
- WebSocket event stream at `/api/runs/:id/stream`.
- REST fallbacks for controls.
- Browser controls for steer, follow-up, prompt, and abort.
- Event replay after refresh via persisted normalized events in Postgres, or `tasksmith-events.jsonl` in legacy file mode.
- Deterministic verifier slice after implementation attempts, with structured `verification` events and redacted stdout/stderr logs.

## Commands

```bash
pnpm start
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
```

The server listens on `PORT`/`HOST` and stores data under `TASKSMITH_DATA_DIR`:

```bash
HOST=127.0.0.1 PORT=3000 TASKSMITH_DATA_DIR=.data/tasksmith pnpm start
```

## API

```txt
GET  /healthz
GET  /api/config
GET  /api/runs
POST /api/runs
POST /api/sources/poll
GET  /api/source-claims
GET  /api/pull-requests
GET  /api/reviews
GET  /api/runs/:id
GET  /api/runs/:id/review
GET  /api/runs/:id/events?after=<sequence>
POST /api/runs/:id/messages
POST /api/runs/:id/abort
POST /api/runs/:id/abort-bash
WS   /api/runs/:id/stream?after=<sequence>
```

When `TASKSMITH_AUTH_ENABLED=1`, all `/api/**` routes and run WebSocket streams require a Better Auth session except `/api/auth/**`; `/healthz` stays public for health checks.

Create Run body:

```json
{
  "title": "Manual run",
  "repoKey": "manual",
  "adapter": "demo",
  "prompt": "Inspect the workspace."
}
```

Control body:

```json
{
  "kind": "steer",
  "message": "Change direction now."
}
```

## Persistence model

For each Run:

```txt
<TASKSMITH_DATA_DIR>/runs/<run-id>/
  workspace/
  home/.pi/agent/
  pi-session/
  events/
    pi-raw.jsonl
    tasksmith-events.jsonl      # legacy file mode / imported pre-Postgres runs
    controls.jsonl              # legacy file mode / imported pre-Postgres runs
  logs/
    verification-<name>-stdout.log
    verification-<name>-stderr.log
  artifacts/
  metadata.json
```

Without `TASKSMITH_DATABASE_URL`, local/test mode stores run/source/review/PR state in legacy JSON files:

```txt
<TASKSMITH_DATA_DIR>/state/runs.json
<TASKSMITH_DATA_DIR>/state/source-claims.json
<TASKSMITH_DATA_DIR>/state/pull-requests.json
<TASKSMITH_DATA_DIR>/state/reviews.json
```

When `TASKSMITH_DATABASE_URL` is set, TaskSmith applies Drizzle/Postgres migrations and imports legacy file-backed state. Postgres is authoritative for runs, attempts, source claims, normalized UI events, control messages, reviews/findings, pull requests, and artifact pointers. Pi session/chat files, raw Pi events, verifier/reviewer logs, workspaces, and large artifacts remain file-backed under the Run directory.

## Deterministic verifier slice

After a runtime attempt reports completion, TaskSmith transitions the Run to `verifying`, runs deterministic commands outside Pi, emits `verification` events, and only then marks the Run `completed` or `failed`.

Default Phase 3 command:

```txt
workspace-smoke: verify that the run workspace contains README.md
```

Operators can replace the default for all repos with a JSON array in `TASKSMITH_VERIFICATION_COMMANDS`:

```json
[
  { "name": "typecheck", "command": "pnpm typecheck", "timeoutMs": 120000 }
]
```

For repo-specific profiles and checkout metadata, set `TASKSMITH_CONFIG_PATH` to a JSON file:

```json
{
  "defaultVerify": [
    { "name": "workspace-smoke", "command": "node -e \"console.log('ok')\"", "timeoutMs": 30000 }
  ],
  "repos": {
    "vosime-admin": {
      "displayName": "Vosime Admin",
      "gitUrl": "git@github.com:YOUR_ORG/vosime-admin.git",
      "defaultBranch": "main",
      "gitProvider": { "type": "github", "owner": "YOUR_ORG", "repo": "vosime-admin" },
      "issueProvider": { "type": "jira", "jql": "project = VOS AND labels = tasksmith AND labels = vosime-admin" },
      "verify": [
        { "name": "typecheck", "command": "pnpm typecheck", "timeoutMs": 120000 },
        { "name": "lint", "command": "pnpm lint", "timeoutMs": 120000 }
      ]
    }
  }
}
```

Configured repositories appear in the manual intake UI. If a repository has `gitUrl`, TaskSmith clones it into the per-run workspace before starting the runtime. `TASKSMITH_VERIFICATION_COMMANDS` overrides `defaultVerify`; explicit `repos.<repoKey>.verify` overrides the default for that repository. Verifier commands run with a minimal environment, `HOME` set to the per-run home directory, and `cwd` set to the run workspace. Stdout/stderr are redacted before event storage and log writing.

## Browser UI

The UI is intentionally operator-focused: project/thread sidebar, live session panel, and bottom composer. It renders only normalized events by default. Raw Pi events remain stored for debugging/audit.

The current visual direction follows a compact T3 Code-style desktop chat surface: dark app chrome, grouped project threads, a thin top bar with only wired controls, transcript-centered content, and a rounded composer.

## Verification performed

Local deterministic checks:

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
```

Browser e2e with `agent-browser` was run against local server and verified:

- page loads,
- manual demo Run can be created,
- live event stream renders,
- steer message can be sent and appears in timeline,
- follow-up message can be queued and appears in timeline,
- abort button cancels active demo run and renders cancelled state.
- deterministic verifier events render after the implementation attempt completes.

## Deployment note

The Docker image now defaults to `pnpm start` and exposes port `3000`. `docker-compose.phase1.yml` currently runs the web server and maps `3000:3000` for the dedicated `tasksmith` host.

## Known limitations

- Active runs are not resumed after process restart; non-terminal runs are marked failed on boot.
- Postgres mode is the app-state foundation, but a real multi-worker queue/lease model is still required before running multiple TaskSmith app processes.
- Demo runtime is for deterministic e2e only.
- Real Pi runtime requires provisioning narrow auth files under `TASKSMITH_PI_AUTH_SOURCE`.
- Fresh-context review, bounded fix attempts, Jira status transitions, and CI fixup are still later phases.
