# Sandcastle-inspired single-task flow

TaskSmith should use a single-task workflow inspired by Sandcastle's `src/templates` patterns, especially:

- `sequential-reviewer`: implement on a branch, then review the same branch in a fresh agent context.
- `parallel-planner-with-review`: explicit planning, implementation, review, and final delivery phases.

TaskSmith adapts this to Pi, persisted events, deterministic verification, and GitHub/Jira source tracking.

## Target flow

```txt
source issue
  -> claim
  -> clone repo/workspace
  -> create branch
  -> plan
  -> implement
  -> deterministic verifier
  -> deep review
  -> fix review/verifier findings, bounded
  -> deliver
```

The user's requested shorthand is:

```txt
plan -> implement -> deep review -> fix -> PR OR squash-and-merge-main
```

## Phase semantics

### 1. Plan

A fresh planning pass reads:

- issue title/body/comments snapshot,
- repository config,
- relevant docs/context files,
- recent commits,
- verification commands.

It emits a persisted plan event. It must not modify files.

### 2. Implement

Pi runs in the per-run workspace and branch. It receives the plan plus wrapped untrusted issue text. It may edit files and commit only when the implementation is complete.

### 3. Verify

TaskSmith, not Pi, runs deterministic verifier commands from config. Failed verification can create a bounded fix attempt.

### 4. Deep review

A fresh-context reviewer inspects the diff, plan, source issue, and verifier result. It emits structured findings. Severe findings block delivery or trigger fix attempts.

### 5. Fix

TaskSmith starts bounded fix attempts using review/verifier findings. `maxFixAttempts` is configured by workflow.

### 6. Deliver

Configurable per instance or per repo:

```json
{ "deliveryMode": "ready_pr" }
```

or:

```json
{ "deliveryMode": "squash_merge_main", "mergeTargetBranch": "main" }
```

`ready_pr` is the safe default and creates a non-draft, ready-to-review PR. `squash_merge_main` is an explicit delivery mode for deployments/repos where direct merge is desired. Legacy `draft_pr` config values are normalized to `ready_pr` for compatibility.

## Current implementation status

Implemented now:

- repository config,
- configured workspace checkout,
- deterministic verifier,
- workflow config parsing/exposure,
- manual runs against configured repos,
- GitHub Issues and Jira source polling with idempotent claims,
- ready-to-review GitHub PR creation after deterministic verification.

Still to implement:

- Jira status/label transitions beyond Run-link/PR-link comments,
- planning pass,
- fresh-context deep review,
- bounded fix attempts,
- optional squash merge to main.
