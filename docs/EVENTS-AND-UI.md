# Events and UI

## Goal

The UI should show the live Pi session and let a human steer it without coupling the browser directly to the Pi process.

## Principle

Render from persisted events.

```txt
Pi raw event
  -> Worker
  -> Event normalizer
  -> Event Store
  -> WebSocket broadcast
  -> UI
```

On reconnect:

```txt
UI loads historical events from API
  -> opens WebSocket
  -> receives new events after last sequence
```

## Why WebSocket

SSE is sufficient for one-way streaming, but TaskSmith needs two-way controls:

- send message,
- steer,
- follow up,
- pause/abort,
- approve future gated actions,
- request current state.

Recommended API:

```txt
GET /runs/:id              # run details
GET /runs/:id/events       # paginated historical events
WS  /runs/:id/stream       # live events + controls
POST /runs/:id/messages    # optional REST fallback
POST /runs/:id/abort       # optional REST fallback
```

## UI controls

### Chat message

When agent is idle:

```txt
UI -> TaskSmith: user_message
TaskSmith -> Pi: prompt
```

When agent is running, UI should ask whether to:

- steer now,
- queue follow-up,
- abort and restart.

### Steer

Use for mid-run correction:

```txt
"Stop editing vosime-admin; this belongs in core-hub. Inspect core-hub first."
```

Pi receives `steer`.

### Follow-up

Use for extra work after current task:

```txt
"After implementation, run the login e2e test and summarize failures."
```

Pi receives `follow_up`.

### Abort

Use for hard stop:

```txt
UI -> TaskSmith: abort
TaskSmith -> Pi: abort
TaskSmith marks attempt aborted
```

## Event types

Use discriminated event types.

```ts
type RunEvent =
  | RunStatusEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | CommandEvent
  | CommandOutputEvent
  | VerificationEvent
  | ReviewEvent
  | PullRequestEvent
  | JiraEvent
  | ErrorEvent;
```

### Required event fields

Every event should include:

```ts
interface BaseEvent {
  id: string;
  runId: string;
  attemptId?: string;
  sequence: number;
  type: string;
  createdAt: string;
}
```

`sequence` must be monotonically increasing per run.

## Chat rendering model

The UI should group events into conversation blocks:

```txt
User message
Assistant response
  tool call
  tool result
  command output
Assistant final summary
Verifier result
Reviewer result
PR result
```

Do not show raw JSON by default. Provide a developer/debug drawer for raw events.

## Live log policy

- Show command output incrementally.
- Collapse very long output.
- Redact known secret patterns.
- Store full logs as artifacts if large.
- Link artifacts from events.

## Control validation

Before forwarding UI commands to Pi, backend must validate:

- user is allowed to control this Run,
- Run is in a controllable state,
- Attempt is active when steering/aborting,
- message size is within limit,
- content is stored before delivery.

## MVP UI screens

### Run list

- Jira key
- title
- repo
- status
- current phase
- PR link if available
- last event timestamp

### Run detail

- Jira metadata
- current status
- live conversation/event stream
- chat/control box
- verification panel
- review panel
- PR panel
- raw event/debug drawer

### Configuration screen, later

- Jira watches
- repo configs
- verification commands
- Pi auth status
- Git provider tokens

## Out of scope for MVP

- Kanban board clone.
- Multi-user collaborative cursors.
- Complex RBAC.
- Replayable terminal emulator.
- Full agent prompt editor.
