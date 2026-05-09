# Proposed Vertical Slices

These slices are designed for incremental agent implementation. Each should be independently demonstrable.

## Slice 1: Manual run event stream

**Type:** HITL  
**Blocked by:** none

### Behavior delivered

A user creates a manual Run with a prompt. The system stores the Run and emits basic lifecycle events. UI/API can read events.

### Acceptance criteria

- [ ] Create Run endpoint exists.
- [ ] Run persisted in DB.
- [ ] Event table supports ordered events.
- [ ] Run detail endpoint returns events.
- [ ] Minimal UI or CLI can show event history.

## Slice 2: Pi runtime subprocess/SDK proof

**Type:** HITL  
**Blocked by:** Slice 1

### Behavior delivered

A worker starts Pi for a Run and streams Pi events into TaskSmith events.

### Acceptance criteria

- [ ] Per-run session dir is created.
- [ ] Pi starts in configured workspace.
- [ ] Raw Pi events are captured.
- [ ] Normalized assistant text events are displayed.
- [ ] Attempt status updates correctly.

## Slice 3: Live control

**Type:** HITL  
**Blocked by:** Slice 2

### Behavior delivered

User can send control messages to an active Pi session.

### Acceptance criteria

- [ ] WebSocket or REST control endpoint exists.
- [ ] User message stored before forwarding.
- [ ] `steer` works while Pi is running.
- [ ] `follow_up` queues after current work.
- [ ] `abort` stops active operation.

## Slice 4: Deterministic verifier

**Type:** AFK  
**Blocked by:** Slice 2

### Behavior delivered

After Pi completes, TaskSmith runs configured commands and stores results.

### Acceptance criteria

- [ ] Repo config supports verifier commands.
- [ ] Command stdout/stderr captured.
- [ ] Exit codes stored.
- [ ] UI displays pass/fail.
- [ ] Failed verifier can be summarized for follow-up attempt.

## Slice 5: Jira pickup

**Type:** HITL  
**Blocked by:** Slice 1

### Behavior delivered

Jira issue matching JQL creates a TaskSmith Run exactly once.

### Acceptance criteria

- [ ] Jira credentials config exists.
- [ ] JQL watch config exists.
- [ ] Poller creates Run for matching issue.
- [ ] Duplicate poll does not create duplicate Run.
- [ ] Jira receives comment with Run URL.

## Slice 6: PR creation

**Type:** AFK  
**Blocked by:** Slice 4

### Behavior delivered

Verified changes are committed, pushed, and opened as a ready-to-review PR.

### Acceptance criteria

- [ ] Branch is created with safe name.
- [ ] Commit author configured.
- [ ] Ready-to-review PR is created.
- [ ] PR body contains Run/Jira/verification links.
- [ ] Jira receives PR link.

## Slice 7: Fresh-context review

**Type:** AFK  
**Blocked by:** Slice 4

### Behavior delivered

A separate review session analyzes the final diff before PR creation or PR readiness.

### Acceptance criteria

- [ ] Review session does not reuse implementation context.
- [ ] Review sees diff and verifier results.
- [ ] Findings are structured.
- [ ] Severe findings block PR or trigger fix attempt.
