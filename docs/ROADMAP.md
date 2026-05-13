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
| 1. Pi runtime spike | In progress | Pi SDK/RPC control, auth, sessions, streaming, and replay are proven locally/server-side |
| 2. Manual Run MVP | In progress | Manual prompt -> Pi/demo run -> live UI -> controls -> event replay |
| 3. Deterministic verifier | In progress | Configured checks/e2e run outside the agent and drive bounded fix attempts |
| 4. Source pickup | In progress | GitHub poll/webhook and Jira poller share idempotent claims; real Jira transitions remain |
| 5. PR/direct delivery | In progress | Verified/reviewed changes become ready PRs or explicit squash-merge commits linked to source |
| 6. Fresh-context review | In progress | Deterministic review, optional CodeRabbit, and bounded review-fix attempts gate delivery |
| 7. CI fixup | In progress | Failed PR CI logs create bounded fix attempts |
| 8. Hardening | In progress | Hetzner deployment, auth, Postgres state, queue/leases/concurrency are in; worker isolation and observability next |

## Implementation principle

Build thin vertical slices. Do not begin with a generic workflow builder. The first useful product is:

```txt
manual Run -> native Pi session -> live UI -> deterministic verifier
```

Then add Jira and PR automation around that core.

## Current immediate next actions

1. Choose and implement the next worker isolation slice:
   - restricted same-host worker user for the smallest useful secret boundary,
   - rootless container/Podman for stronger filesystem/process boundaries,
   - or a two-stage approach: restricted user now, container later.
2. Add operator observability for queues, leases, stuck runs, and source pickup decisions.
3. Deepen Jira lifecycle automation once real Jira credentials/status mappings are available.
4. Keep dogfooding one GitHub issue at a time before re-enabling unattended background polling.

## Detailed tracker

Use [`docs/TRACKER.md`](./TRACKER.md) for:

- milestone checklists,
- dependencies,
- exit gates,
- cross-cutting backlog,
- definition of ready/done,
- current status.
