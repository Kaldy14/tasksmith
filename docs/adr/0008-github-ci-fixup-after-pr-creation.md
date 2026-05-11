# ADR 0008: Poll GitHub CI and run bounded fixup after PR creation

## Status

Accepted

## Context

Ready-to-review PR delivery is useful, but TaskSmith previously stopped immediately after creating a PR. That left failed PR CI as a manual follow-up. The desired TaskSmith flow includes a CI fixup phase: watch PR checks, collect failure logs, make a bounded fix attempt, and push a fix commit to the existing PR branch.

## Decision

For `ready_pr` delivery, TaskSmith will poll GitHub PR checks after the PR is created. The CI watcher uses the configured GitHub CLI profile and runs:

- `gh pr checks` to inspect PR checks,
- `gh run view --log-failed` for failed GitHub Actions logs when an Actions run id is available.

If checks pass or no checks are present, the Run transitions to `pr_created`. If checks fail, TaskSmith starts a bounded CI fix attempt using the failed check summary/log excerpt, re-runs deterministic verification and review, and pushes a fix commit to the existing PR branch. The loop is bounded by `workflow.maxCiFixAttempts`; polling cadence and timeout are controlled by `workflow.ciPollIntervalMs` and `workflow.ciTimeoutMs`.

This applies to `ready_pr` delivery only. `squash_merge_main` has no PR object to poll and remains gated by pre-delivery verification/review.

## Consequences

Positive:

- Failed PR CI can be corrected without manual copy/paste of logs.
- Fixes are pushed as additional TaskSmith commits to the same PR branch.
- The loop is bounded and auditable through normalized `ci`, `run_status`, command, verification, review, and delivery events.

Negative:

- The first implementation supports GitHub Checks/Actions through `gh`; other CI providers remain future work.
- If a check provider does not expose an Actions run id, TaskSmith can summarize the failed check but may not fetch logs.
- CI polling is synchronous inside the Run orchestration path; queue/lease semantics are still needed before multi-worker deployments.

## Acceptance criteria

- [x] After ready PR creation, TaskSmith polls GitHub PR checks.
- [x] Failed checks fetch failed Actions logs when possible.
- [x] Failed CI starts a bounded fix attempt with log context.
- [x] Fix attempts push commits to the existing PR branch, not a new PR.
- [x] Passing/no checks transition the Run to `pr_created`.
- [x] Delivery e2e covers failed CI followed by a fix commit and passing checks.
