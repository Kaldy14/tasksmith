# ADR 0001: Use Pi as the first-class runtime

## Status

Proposed

## Context

TaskSmith needs live, steerable, persistent autonomous coding sessions. The desired UI must show what the agent is doing and allow additional commands during or after the run.

Existing tools often integrate agents through generic CLI or ACP adapters. Kandev supports Pi through `pi-acp`, which is useful but hides Pi behind a generic protocol. Pi itself exposes richer native controls through SDK/RPC.

## Decision

TaskSmith will use Pi directly through SDK or RPC for the MVP.

Preferred order:

1. Pi SDK if worker is Node/TypeScript.
2. Pi RPC if worker is not TypeScript or subprocess isolation is preferred.
3. Pi JSON mode only for simple one-shot utilities.
4. ACP as optional future compatibility layer, not primary runtime.

## Consequences

Positive:

- Direct support for `prompt`, `steer`, `follow_up`, `abort`, state, messages, and session stats.
- Better UI/control integration.
- Explicit session/auth persistence.
- Less dependence on ACP adapter behavior.

Negative:

- More provider-specific code.
- Later multi-agent support requires adapter abstraction.
- Worker language choice becomes more important if using SDK.

## Acceptance criteria

- [ ] MVP can start Pi session with custom session dir.
- [ ] MVP can stream Pi events to Event Store.
- [ ] MVP can send steer/follow-up/abort from UI.
- [ ] MVP can recover/replay session history from persisted events.
