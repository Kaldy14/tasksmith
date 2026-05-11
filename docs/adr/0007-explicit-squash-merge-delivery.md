# ADR 0007: Support explicit squash-merge delivery to main

## Status

Accepted

## Context

TaskSmith originally delivered changes only as ready-to-review pull requests. That remains the safest default because it preserves human PR review before merge. For the TaskSmith repository itself, we want a dogfooding mode where verified and reviewed agent changes can be delivered directly to `main` as one squashed commit.

Direct merge is high impact: it writes to the protected integration branch and bypasses the PR object. It must therefore be opt-in, auditable, and gated by TaskSmith verification/review.

## Decision

TaskSmith will support `workflow.deliveryMode = "squash_merge_main"` as an explicit global or per-repository delivery mode.

When enabled, delivery:

1. Requires a configured `gitUrl` checkout.
2. Uses `workflow.mergeTargetBranch`, falling back to `repo.defaultBranch`, then `main`.
3. Requires a non-empty workspace diff.
4. Runs only after deterministic verification and fresh-context review pass.
5. Commits all workspace changes as one TaskSmith-authored commit.
6. Pushes `HEAD` to `refs/heads/<mergeTargetBranch>` without force.
7. Emits delivery events containing target branch and commit URL/SHA.
8. Comments on GitHub/Jira source issues when credentials are available.

The personal TaskSmith config opts the `tasksmith` repository into `squash_merge_main`; other repositories keep the global `ready_pr` default unless explicitly overridden.

## Consequences

Positive:

- TaskSmith can dogfood direct delivery on itself without manual PR merge steps.
- The target branch receives a single squashed TaskSmith commit rather than intermediate agent commits.
- Non-forced push preserves branch protection and fails safely if the branch advanced or permissions are insufficient.

Negative:

- Human PR review can be bypassed for explicitly configured repositories.
- Rollback requires normal Git revert/reset workflows.
- Same-UID Pi/tool isolation remains a security hardening gap before using direct merge with high-value repositories.

## Acceptance criteria

- [x] `ready_pr` remains the default delivery mode.
- [x] `squash_merge_main` is accepted only through explicit workflow config.
- [x] Direct delivery creates one TaskSmith commit and pushes without force to the configured target branch.
- [x] Direct delivery emits normalized delivery and command events.
- [x] Delivery e2e covers both ready PR creation and squash-merge direct push.
- [x] Documentation explains requirements and risks.
