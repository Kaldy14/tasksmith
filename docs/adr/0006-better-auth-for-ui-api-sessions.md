# ADR 0006: Use Better Auth for TaskSmith UI/API sessions

## Status

Accepted

## Context

TaskSmith is moving from tailnet-only access toward a deployable control plane. The UI can create runs, steer active agents, poll sources, edit repository config, and inspect events. These surfaces must not be publicly reachable without authentication.

TaskSmith already uses Postgres for app state when `TASKSMITH_DATABASE_URL` is configured, and Better Auth was selected as the small Node-native auth layer that can share that database.

## Decision

TaskSmith will use Better Auth email/password sessions for browser UI, `/api/**` routes, WebSocket run streams, `/config`, source polling, and run controls when `TASKSMITH_AUTH_ENABLED=1`.

Better Auth uses the existing Postgres database through the Drizzle adapter and adds the standard `user`, `session`, `account`, and `verification` tables. Public sign-up is disabled in the app. The first admin user is created out-of-band with `pnpm auth:bootstrap-admin` using one-shot `TASKSMITH_BOOTSTRAP_ADMIN_*` environment variables.

`/healthz` remains unauthenticated for local/systemd health checks. `/api/auth/**` remains unauthenticated so Better Auth can sign users in and out.

Local and deterministic e2e deployments may leave `TASKSMITH_AUTH_ENABLED` unset, preserving the file-only/no-auth developer path.

## Consequences

Positive:

- TaskSmith can safely protect control surfaces before any non-tailnet exposure.
- Auth state is queryable and durable in the same Postgres deployment as app state.
- Existing no-auth tests and local demos keep working unless auth is explicitly enabled.

Negative:

- Operators must manage a strong auth secret and bootstrap admin credentials.
- Role/policy granularity is not implemented yet; all authenticated users are currently equivalent.
- Better Auth protects the app boundary but does not solve same-UID Pi/tool execution isolation.

## Acceptance criteria

- [x] `TASKSMITH_AUTH_ENABLED=1` requires Postgres and a 32+ byte auth secret.
- [x] Better Auth routes are mounted under `/api/auth/**`.
- [x] UI/API/WebSocket/config/source polling/run controls require a session when auth is enabled.
- [x] Public sign-up is disabled in the app.
- [x] A bootstrap admin script can create the first email/password user.
- [x] Auth can be omitted for local deterministic tests.
