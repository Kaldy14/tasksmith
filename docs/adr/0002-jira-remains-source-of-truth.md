# ADR 0002: Keep Jira as the source of truth for task intake

## Status

Proposed

## Context

The target workflow starts from Jira. Existing tools often import Jira issues into their own internal task boards. That can be useful, but TaskSmith should not require engineers to monitor a second board for task state.

## Decision

Jira remains the source of truth for task intake and high-level status. TaskSmith owns execution state, logs, attempts, verification, and PR metadata, but must write meaningful status back to Jira.

## Consequences

Positive:

- Engineers keep using Jira.
- TaskSmith runs are easy to audit from the original issue.
- Reduces product/UI scope for MVP.

Negative:

- Requires robust Jira state sync.
- Requires idempotent issue claiming.
- Jira workflow differences may require configuration.

## Acceptance criteria

- [ ] Jira issue can trigger a TaskSmith Run.
- [ ] Jira issue receives a Run link comment.
- [ ] Jira issue is marked claimed/running.
- [ ] Jira issue receives PR link or failure summary.
- [ ] Duplicate polling does not create duplicate Runs.
