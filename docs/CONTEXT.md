# Context

## Product name

**TaskSmith**

A self-hosted platform that turns issue-tracker tasks into verified, reviewable pull requests using autonomous coding agents.

## Target user

An internal engineering team that wants a controlled autonomous coding workflow:

- Jira is the task intake surface.
- Repositories include `vosime-admin`, `core-hub`, and potentially a future monorepo.
- The system should run on a Hetzner server.
- Humans should be able to see and steer active agent work.
- The system should prefer subscription-authenticated Pi usage over API-key metering where possible.

## Primary goal

Build an internal agent control plane with this lifecycle:

```txt
Jira/GitHub issue marked tasksmith
  -> TaskSmith claims issue
  -> creates Run
  -> starts isolated Pi session in sandbox/worktree
  -> streams live events to UI
  -> allows human steering/follow-up/abort
  -> runs deterministic verification
  -> launches independent review
  -> creates ready-to-review PR
  -> updates Jira with status, logs, and PR link
```

## Non-goals for MVP

- Auto-merge to main.
- Production secret access from agent sandboxes.
- Multi-tenant SaaS support.
- Complex RBAC beyond a trusted internal team.
- Supporting every agent provider from day one.
- Replacing Jira as the planning system.

## Glossary

### Run

A top-level unit of autonomous work created from a Jira issue, manual prompt, or future trigger. A Run owns attempts, event history, verification results, review results, and PR state.

### Attempt

One execution attempt within a Run. A failed Run may have multiple attempts, e.g. implementation attempt, fix attempt, review-fix attempt.

### Sandbox

An isolated execution environment for agent work. It contains a repository checkout or worktree, constrained secrets, resource limits, and per-run home/session directories.

### Pi Session

A native Pi coding-agent session controlled via Pi SDK or Pi RPC. The session should be persisted under the Run so it can be inspected and potentially resumed.

### Agent Adapter

A provider-specific runtime adapter. For MVP, `PiAdapter` is primary. Later adapters may include Codex, Claude Code, ACP, or OpenCode.

### Event Store

Persistent append-only record of normalized and raw agent/runtime events. The UI renders from the event store and reconnects from it.

### Verifier

Deterministic command runner outside the agent. It runs configured checks such as typecheck, lint, tests, and e2e.

### Reviewer

An independent fresh-context review pass over the final diff. It may use Pi or another adapter, but it must not be the same conversational context as the implementation agent.

### Jira Claim

An idempotent record indicating that a Jira issue is being handled by TaskSmith. Prevents duplicate runs.

## Key constraints

- Jira content is untrusted prompt input.
- Repositories may require browser/e2e verification.
- Agent work must be observable and interruptible.
- Agent auth/session state must survive restarts where possible.
- The first production version should be PR-only.

## Open questions

- Which Git provider will be primary: GitHub, GitLab, or both?
- What exact Jira statuses should TaskSmith transition through?
- Should TaskSmith run as Docker, rootless Podman, or another isolation layer?
- Will Pi run inside the sandbox container or in a host-side controller with sandboxed tool execution?
- What is the minimal UI for MVP: run list + event stream + chat box, or richer task board?
