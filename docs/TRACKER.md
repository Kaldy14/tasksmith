# TaskSmith Project Tracker

## Current status

**Stage:** Phase 8 — hardening foundation  
**Code status:** Manual Run, verifier, bounded verifier fix attempts, source pickup, per-repo init commands, config UI, fresh-context review, ready-to-review GitHub PR delivery, Postgres app state, and Better Auth UI/API protection implemented  
**Primary next milestone:** restricted-user/container worker isolation, then extend bounded fix attempts to review findings and CI fixup.

TaskSmith currently has durable product/architecture docs, ADRs, research references, and implementation briefs. The next work should be a technical spike, not a full app scaffold.

## Original target flow

This tracker preserves the desired product flow:

```txt
Jira/GitHub issue marked tasksmith
  -> TaskSmith claims issue idempotently
  -> TaskSmith creates a Run
  -> Worker creates sandbox/worktree
  -> Worker starts native Pi session
  -> UI streams the live agent session
  -> Human can steer/follow-up/abort
  -> Agent implements change
  -> Deterministic verifier runs tests/e2e
  -> Failed verifier output creates fix attempt
  -> Fresh-context review checks the diff
  -> Ready-to-review PR is created
  -> Jira is updated with status, logs, PR link
  -> CI is monitored and fixup attempts are run
```

## Influences from researched projects

| Source | Inspiration to keep | What TaskSmith changes |
|---|---|---|
| Kandev | Jira watches, multi-stage workflow: Spec -> Work -> Review -> QA -> PR -> CI Fixup | Keep Jira as source of truth; use native Pi instead of Pi behind ACP; deterministic verifier outside prompts |
| CodeForge | Worker queue, event streaming/replay, PR service, review task model | Make Jira pickup first-class; add Pi-native live control; prefer WebSocket for two-way control |
| OpenHands | Conversation UI, sandbox/product feel, observable agent work | Avoid Enterprise/cloud dependency; do not make LiteLLM/API-key model central |
| Sandcastle | Lightweight runner/provider boundary, Docker execution ideas | Do not make one-shot JSON mode the primary Pi runtime; design for persistent interactive sessions |
| Pi | SDK/RPC session control: prompt, steer, follow_up, abort, messages, stats | Make Pi the primary runtime and build product semantics around it |

## Status legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked / needs decision
- `[?]` Unknown / spike required

## Milestone overview

| Milestone | Status | Goal | Exit gate |
|---|---:|---|---|
| M0 — Foundation docs | `[x]` | Capture product intent, research, ADRs, and initial plan | Future agent can understand project without chat history |
| M1 — Pi runtime spike | `[~]` | Prove Pi SDK/RPC works on target host with persistent sessions and live controls | Can prompt, stream, steer, follow-up, abort, replay messages |
| M2 — Manual Run MVP | `[~]` | Create manual Run, run Pi in workspace, stream UI events | Browser shows live Pi work and accepts control messages |
| M3 — Deterministic verifier | `[~]` | Run configured checks/e2e after agent work | Verification pass/fail drives next Run state |
| M4 — Source pickup | `[~]` | Poll GitHub/Jira, claim issue, create Run, update source | Tagged issue becomes exactly one TaskSmith Run |
| M5 — PR creation | `[~]` | Commit/push verified diff and create ready-to-review PR | PR links source issue, Run, verification, review summary |
| M6 — Fresh-context review | `[~]` | Independent review before PR readiness | Findings are structured and severe findings block delivery |
| M7 — CI fixup | `[~]` | Watch PR CI and fix failures | Failed CI creates bounded fix attempts |
| M8 — Hardening | `[ ]` | Security, auth, deployment, observability | Safe enough for internal beta on real repos |

## M0 — Foundation docs

**Status:** `[x]` Done

### Completed

- [x] Project named `TaskSmith`.
- [x] GitHub public repo created under `Kaldy14/tasksmith`.
- [x] Durable docs created in `docs/`.
- [x] ADRs created for Pi-first runtime, Jira source of truth, event-sourced UI, deterministic verification.
- [x] Research summary captured for Kandev, CodeForge, OpenHands, Sandcastle, Open Agents, Pi.
- [x] Initial implementation briefs created.

### Remaining

- [ ] Keep this tracker updated as work begins.

## M1 — Pi runtime spike

**Status:** `[~]` In progress  
**Type:** technical spike  
**Inspired by:** Pi SDK/RPC docs, Kandev Pi ACP limitations, Sandcastle runner experiments

Phase 1 implementation note: the first slice is a standalone Pi SDK runtime harness, documented in [`PI-RUNTIME-SPIKE.md`](./PI-RUNTIME-SPIKE.md). It is not the full app scaffold. It establishes the runtime/event/control contract that the future Hetzner-hosted API and UI will use.

### Goal

Prove TaskSmith can use Pi as a native, steerable runtime on the intended host/sandbox model.

### Tasks

- [x] Decide worker language for spike: TypeScript SDK first; keep RPC as fallback for process isolation.
- [x] Prepare dedicated Hetzner host baseline (`tasksmith`, 178.105.101.73) with SSH hardening, firewall, Docker, and `/opt/tasksmith` directories.
- [ ] Install/provision Pi auth on the intended Hetzner environment via narrow auth files.
- [ ] Authenticate Pi using subscription auth.
- [ ] Create throwaway workspace with a tiny test repo.
- [x] Start Pi with per-run home and session directory in local spike harness.
- [x] Capture raw and normalized event streams to JSONL.
- [x] Send initial prompt through TaskSmith wrapper.
- [x] Send `steer` while Pi is running and record e2e verification.
- [x] Send `follow_up` after active work and record e2e verification.
- [x] Send `abort` and verify process/session state with e2e.
- [x] Query persisted messages after run via session inspection command.
- [x] Restart worker process and verify event replay from normalized JSONL.

### Exit gate

- [x] A small script demonstrates prompt + stream + steer + follow-up + abort locally.
- [x] Session files are written under a per-run directory locally.
- [x] No full user home directory is mounted/copied.
- [x] Findings are documented in `docs/PI-FIRST-RUNTIME.md` and `docs/PI-RUNTIME-SPIKE.md`.
- [x] Build and run Phase 1 Docker image on the target Hetzner host with deterministic no-auth e2e.
- [ ] Repeat the authenticated runtime e2e on the target Hetzner host after Pi auth is provisioned.

### Open decisions

- `[?]` Does Pi run inside the sandbox container or host-side with sandboxed tools?
- `[?]` Is SDK stable enough for our worker, or should MVP use RPC for process isolation?
- `[?]` Which Pi files are strictly required for subscription auth on Hetzner?

## M2 — Manual Run MVP

**Status:** `[~]` In progress  
**Type:** first product slice  
**Inspired by:** CodeForge task/worker/event model, OpenHands conversation UI

Phase 2 implementation note: the first vertical slice is documented in [`MANUAL-RUN-MVP.md`](./MANUAL-RUN-MVP.md). It includes a Node/TypeScript API, browser UI, Postgres-backed app state when configured, legacy file-backed local mode, WebSocket live stream, deterministic demo runtime, and Pi SDK runtime path.

### Goal

Before Jira automation, manually start a Run and watch/control the Pi session from the UI.

### Backend tasks

- [x] Choose app stack and package layout: Node/TypeScript monolith for Phase 2.
- [~] Create persistence model for `runs`, `attempts`, `events`: Postgres is primary for app state and normalized events when configured; filesystem remains primary for Pi transcripts, raw events, logs, workspaces, and large artifacts.
- [x] Implement initial Run state machine.
- [x] Implement event append API with per-run sequence numbers.
- [x] Implement in-process worker/runtime manager.
- [x] Implement `PiAdapter` with start/prompt/steer/follow-up/abort.
- [x] Normalize raw Pi events into TaskSmith events.
- [x] Store raw Pi events and normalized JSONL event logs.
- [x] Implement run detail/read APIs.
- [x] Implement WebSocket endpoint for live event stream and controls.

### UI tasks

- [x] Run list page.
- [x] Run detail page.
- [x] Live conversation/event stream.
- [x] Chat/control box.
- [x] Controls for steer/follow-up/abort.
- [x] Reconnect and replay history from normalized events.
- [ ] Debug drawer for raw events.

### Exit gate

- [x] User can create a manual Run with deterministic demo runtime locally and on the `tasksmith` host.
- [x] Pi runs in an isolated workspace through the browser UI after auth is provisioned on the host.
- [x] UI displays live assistant/tool/command events.
- [x] UI can steer, queue follow-up, and abort with deterministic demo runtime.
- [x] Refreshing the page replays history from normalized events.

## M3 — Deterministic verifier

**Status:** `[~]` Initial vertical slice in progress  
**Type:** quality gate  
**Inspired by:** Kandev QA phase, CodeForge review/executor separation

### Goal

TaskSmith, not the agent, runs configured checks after implementation.

### Tasks

- [x] Define repository config format: `TASKSMITH_REPO_CONFIG_PATH` supports `defaultVerify` and per-repo `verify` command profiles.
- [~] Add repo registry for `vosime-admin`, `core-hub`, future monorepo: config format exists; real repo profiles still need to be authored.
- [x] Add project config UI backed by `TASKSMITH_CONFIG_PATH`.
- [x] Add per-repo workspace init commands before implementation runtime starts.
- [ ] Add verifier command model: name, command, timeout, env policy, artifact policy.
- [x] Implement verifier runner outside Pi.
- [x] Capture stdout/stderr and exit codes.
- [x] Store verification results and redacted logs.
- [~] Display verifier results in the event stream; dedicated verifier panel still pending.
- [x] Feed failed verifier summary into a bounded fix attempt.
- [x] Add max fix attempt policy.
- [ ] Support e2e artifacts: screenshots, traces, videos where available.

### Exit gate

- [x] Manual Run transitions to `verifying` after the implementation runtime finishes.
- [x] Passing checks move Run to `completed`.
- [x] Failing checks either create a bounded `fixing` attempt or fail immediately when `maxFixAttempts` is exhausted/zero.
- [x] The agent cannot mark verification passed by itself.

## M4 — Source pickup: GitHub Issues and Jira

**Status:** `[~]` GitHub Issues and Jira pickup foundation in progress
**Type:** source integration  
**Inspired by:** Kandev Jira JQL watches, GitHub Issues for repository-scoped intake, but with external trackers kept as source of truth

### Goal

A GitHub issue or Jira issue matching configured readiness criteria creates exactly one TaskSmith Run.

### Tasks

- [~] Configure source credentials securely: GitHub CLI profile support is documented; Jira env/secrets still pending.
- [x] Define repository/source config: per-repo GitHub Issues or Jira metadata, git checkout URL, branch, verification profile, and Sandcastle-style workflow.
- [x] Define Jira watch config shape: `tasksmith` readiness label plus configurable label-to-repo routing.
- [x] Extend Run source model for manual/GitHub issue/Jira source metadata.
- [x] Add source claim store with unique claim keys; Postgres unique constraints are used when DB mode is configured, with legacy JSON support for local tests.
- [x] Implement manual GitHub Issues poller endpoint for configured repos.
- [x] Add GitHub issue Run-link comment after successful claim.
- [x] Implement Jira poller with environment-sourced Jira credentials.
- [x] Add Jira Run-link comment after successful claim.
- [x] Implement repository routing from Jira labels via `sourceFlow.jiraRepoRouting.labels`.
- [x] Add source-pickup e2e proving idempotent GitHub and Jira polling.
- [ ] Add Jira status/label transition config.
- [ ] Handle missing repo route by creating `waiting_for_user` Run.
- [~] Add UI for seeing source metadata and claims: run header links source issue; claims list is API-only.

### Exit gate

- [x] Jira issue with `tasksmith` creates one Run in the source-pickup e2e.
- [x] Duplicate polling does not duplicate Run for GitHub Issues or Jira.
- [x] GitHub issue receives Run link comment.
- [x] Jira receives Run link comment in the source-pickup e2e.
- [ ] Jira status/labels reflect claimed/running/failed/pr-created.
- [~] Repo routing works for GitHub Issues repos by configured repo and for Jira labels in e2e; real `vosime-admin`/`core-hub` auth/config still need validation.

## M5 — Delivery: PR creation or explicit direct merge

**Status:** `[~]` GitHub ready-PR and explicit squash-merge foundations implemented  
**Type:** delivery integration  
**Inspired by:** CodeForge PR service, Kandev PR phase

### Goal

Turn verified and reviewed changes into either a ready-to-review PR or an explicit `squash_merge_main` direct delivery, then link the result back to the source issue when credentials are available.

### Tasks

- [x] Decide first Git provider: GitHub first; GitLab deferred.
- [x] Configure provider token storage via `ghConfigDir` profile references, not copied secrets.
- [x] Implement safe branch naming.
- [x] Implement commit author config.
- [x] Detect changed files and block empty PRs.
- [x] Create branch from base branch.
- [x] Commit changes.
- [x] Push delivery branch or direct target branch without force.
- [x] Create ready-to-review PR without `--draft` in `ready_pr` mode.
- [x] Implement explicit `squash_merge_main` direct delivery with a single TaskSmith commit and non-forced push to the target branch.
- [~] Generate PR body with source link, Run link, verification summary, and review placeholder; real review summary pending M6.
- [x] Store PR metadata for PR delivery.
- [x] Update GitHub/Jira source issue with PR or direct-merge comment when credentials are available.

### Exit gate

- [x] Verified Run produces ready-to-review PR in delivery e2e.
- [x] Verified Run can use explicit `squash_merge_main` to push one TaskSmith commit to the configured target branch in delivery e2e.
- [x] PR body has enough context for human review, including AI-generated marker.
- [~] Jira/GitHub source issues receive PR/direct-merge comments; real Jira status/label transitions remain pending.
- [x] Auto-merge is not the default; direct merge requires explicit `squash_merge_main` config.

## M6 — Fresh-context review

**Status:** `[~]` Deterministic fresh-context review foundation implemented  
**Type:** quality gate  
**Inspired by:** Kandev Review phase, CodeForge review task type

### Goal

A separate review pass checks the final diff before PR is marked ready.

### Tasks

- [~] Define review prompt contract: deterministic diff-review contract exists; LLM prompt contract still pending.
- [~] Start review in separate Pi session/context: current reviewer is a separate deterministic TaskSmith context, not the implementation session; Pi-backed reviewer pending.
- [x] Provide diff, task requirements/source metadata, and verifier result context to reviewer via persisted diff/run metadata.
- [x] Require structured findings: severity, file, line, title, description, suggested fix.
- [x] Store findings.
- [~] Display review panel: review events render in stream; dedicated review panel still pending.
- [x] Define block policy for severe findings: `high`/`critical` block delivery.
- [ ] Create fix attempt from findings.
- [x] Include review summary in PR.

### Exit gate

- [x] Implementation context is not reused for deterministic review.
- [x] Review findings are structured and persisted.
- [x] Severe findings block PR readiness in review e2e.

## M7 — CI fixup

**Status:** `[~]` GitHub polling/fixup foundation implemented  
**Type:** post-PR automation  
**Inspired by:** Kandev CI Fixup phase, CodeForge webhook concepts

### Goal

After PR creation, TaskSmith watches CI checks and performs bounded fix attempts.

### Tasks

- [x] Poll GitHub PR check status after ready PR creation.
- [x] Fetch failed GitHub Actions logs via `gh run view --log-failed` when run ids are available.
- [x] Summarize relevant failure output into a CI fix prompt.
- [x] Create CI fixup attempt in same workspace/branch.
- [x] Push new fix commit to the existing PR branch.
- [x] Re-poll CI after the fix commit.
- [x] Stop after `maxCiFixAttempts` is exhausted.
- [~] Update Jira/GitHub/UI on success/failure: UI events exist; source comments/status transitions still need production hardening.

### Exit gate

- [x] Failed CI produces one bounded fix attempt in delivery e2e.
- [~] Passing CI updates Run/UI; Jira status transition remains pending.
- [x] Repeated failures stop safely with clear report when attempts are exhausted.

## M8 — Hardening and internal beta

**Status:** `[~]` In progress  
**Type:** production readiness

### Tasks

- [x] Add Better Auth for UI/API before exposing a real public URL.
- [ ] Add role/policy for who can steer/abort/rerun.
- [ ] Implement secret redaction tests.
- [ ] Review stronger sandbox isolation as a future hardening improvement; MVP runs on a dedicated TaskSmith server.
- [ ] Add resource limits and timeouts.
- [ ] Add artifact retention policy.
- [ ] Add DB backup plan.
- [ ] Add deployment docs for Hetzner.
- [ ] Add observability: metrics, logs, run duration, failure rates.
- [ ] Add admin config UI or config file docs.

### Exit gate

- [ ] One real internal repo can be handled end-to-end.
- [ ] Failure modes are visible and recoverable.
- [ ] Secrets are not visible in UI event streams.
- [ ] Human review remains required before merge.

## Cross-cutting backlog

### Product / UX

- [ ] Run list filtering by status, repo, Jira key.
- [ ] Run timeline view.
- [ ] Compact assistant/tool event rendering.
- [ ] Raw event debug drawer.
- [ ] Manual retry/fix button.
- [ ] Manual repo route picker.
- [ ] PR and Jira panels.

### Security

- [ ] Prompt-injection wrapper for Jira issue text.
- [ ] Secret redaction library.
- [ ] Per-run auth material copy/mount policy.
- [ ] No production secret policy enforcement.
- [ ] Network policy investigation.
- [ ] Docker vs rootless Podman decision.

### Reliability

- [ ] Worker crash recovery.
- [ ] Stuck run detector.
- [ ] Retry policy per phase.
- [ ] Event sequence consistency tests.
- [ ] Jira reconciliation job.
- [ ] Workspace cleanup job.

### Future agents/providers

- [ ] Add Codex as turn-based adapter only after Pi MVP.
- [ ] Add ACP adapter for generic agent support.
- [ ] Add Claude Code adapter if needed.
- [ ] Keep provider-specific raw events but normalize UI events.

## Definition of Ready

A slice is ready to implement when:

- [ ] Desired behavior is documented.
- [ ] Acceptance criteria are independently verifiable.
- [ ] Required secrets/accounts are available or mocked.
- [ ] Test repository or fixture is identified.
- [ ] Out-of-scope items are explicit.

## Definition of Done

A slice is done when:

- [ ] Behavior works end-to-end.
- [ ] Events/logs are visible in UI/API.
- [ ] Failure state is handled.
- [ ] Tests or manual verification notes exist.
- [ ] Docs are updated.
- [ ] No secrets are committed or displayed.

## Immediate next actions

1. Decide worker implementation path: Pi SDK in TypeScript vs Pi RPC subprocess.
2. Create a small Pi runtime spike script.
3. Run it locally, then on Hetzner.
4. Record Pi auth/session requirements.
5. Only then scaffold the app.
