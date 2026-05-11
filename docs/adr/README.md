# Architecture Decision Records

ADRs capture decisions that should not depend on chat history.

## Index

- [0001: Use Pi as the first-class runtime](./0001-pi-first-runtime.md)
- [0002: Keep Jira as the source of truth for task intake](./0002-jira-remains-source-of-truth.md)
- [0003: Render the run UI from persisted events](./0003-event-sourced-run-ui.md)
- [0004: Run deterministic verification outside the agent](./0004-deterministic-verification-outside-agent.md)
- [0005: Use Postgres for TaskSmith app state and keep Pi transcripts/artifacts on disk](./0005-postgres-for-metadata-files-for-artifacts.md)
- [0006: Use Better Auth for TaskSmith UI/API sessions](./0006-better-auth-for-ui-api-sessions.md)

## Template

```md
# ADR NNNN: Title

## Status

Proposed | Accepted | Superseded

## Context

What forces led to this decision?

## Decision

What are we choosing?

## Consequences

Positive and negative consequences.

## Acceptance criteria

How do we know the decision is implemented?
```
