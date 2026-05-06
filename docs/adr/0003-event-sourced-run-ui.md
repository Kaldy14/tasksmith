# ADR 0003: Render the run UI from persisted events

## Status

Proposed

## Context

The UI must show live agent progress and remain useful after refresh, worker crash, or run completion. Directly streaming process stdout to the browser is insufficient because it loses replayability and auditability.

## Decision

All meaningful run activity must be persisted as ordered events. The UI loads historical events and subscribes to live updates.

## Consequences

Positive:

- Reconnect/replay works.
- Debugging and audit are easier.
- Provider-specific raw events can be preserved.
- UI is decoupled from worker process lifetime.

Negative:

- Requires event schema discipline.
- Requires storage and redaction policy.
- Raw event volume may become large.

## Acceptance criteria

- [ ] Every Run has monotonically sequenced events.
- [ ] UI can reconstruct a completed Run from stored events.
- [ ] UI can reconnect to an active Run without losing messages.
- [ ] Raw provider events are stored or archived where safe.
- [ ] Sensitive values are redacted before display.
