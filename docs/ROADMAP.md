# Roadmap

TaskSmith's detailed work tracker lives in [`TRACKER.md`](./TRACKER.md). This file is the shorter roadmap view.

## North star

```txt
Jira/GitHub issue marked tasksmith
  -> claim issue
  -> create Run
  -> start native Pi session in isolated workspace
  -> stream live UI
  -> allow steer/follow-up/abort
  -> verify deterministically, including e2e where configured
  -> fresh-context review
  -> ready-to-review PR
  -> Jira update
  -> CI fixup loop
```

## Roadmap phases

| Phase | Status | Outcome |
|---|---:|---|
| 0. Foundation docs | Done | Product context, research, ADRs, and briefs exist |
| 1. Pi runtime spike | Next | Prove Pi SDK/RPC control, auth, sessions, and streaming |
| 2. Manual Run MVP | Not started | Manual prompt -> Pi run -> live UI -> controls -> event replay |
| 3. Deterministic verifier | Not started | Configured checks/e2e run outside the agent and drive fix attempts |
| 4. Source pickup | In progress | GitHub/Jira poller creates exactly one Run in e2e; real tracker auth/status sync remains |
| 5. PR creation | In progress | Verified changes become ready-to-review GitHub PRs linked to source issue and Run |
| 6. Fresh-context review | Not started | Independent diff review blocks or fixes risky changes |
| 7. CI fixup | Not started | Failed PR CI logs create bounded fix attempts |
| 8. Hardening | Not started | Hetzner deployment, auth, redaction, isolation, observability |

## Implementation principle

Build thin vertical slices. Do not begin with a generic workflow builder. The first useful product is:

```txt
manual Run -> native Pi session -> live UI -> deterministic verifier
```

Then add Jira and PR automation around that core.

## Current immediate next actions

1. Choose Pi integration mode for the spike:
   - TypeScript SDK if the worker is Node/TypeScript.
   - Pi RPC if subprocess isolation and language independence matter more.
2. Prove prompt + stream + steer + follow-up + abort with a per-run session directory.
3. Document Pi auth/session requirements on the target host.
4. Scaffold the application only after the Pi runtime spike is successful.

## Detailed tracker

Use [`docs/TRACKER.md`](./TRACKER.md) for:

- milestone checklists,
- dependencies,
- exit gates,
- cross-cutting backlog,
- definition of ready/done,
- current status.
