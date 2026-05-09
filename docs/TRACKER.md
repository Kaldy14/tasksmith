# TaskSmith Project Tracker

## Current status

**Stage:** Phase 2 — Manual Run MVP  
**Code status:** Manual Run API/UI vertical slice started  
**Primary next milestone:** harden the Phase 3 verifier slice with repo-specific command profiles, then continue toward Jira pickup and PR creation.

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
  -> Draft PR is created
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
| M4 — Jira pickup | `[ ]` | Poll Jira, claim issue, create Run, update Jira | Tagged Jira issue becomes exactly one TaskSmith Run |
| M5 — PR creation | `[ ]` | Commit/push verified diff and create draft PR | PR links Jira, Run, verification, review summary |
| M6 — Fresh-context review | `[ ]` | Independent review before PR readiness | Findings are structured and can block/fix |
| M7 — CI fixup | `[ ]` | Watch PR CI and fix failures | Failed CI creates bounded fix attempts |
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

Phase 2 implementation note: the first vertical slice is documented in [`MANUAL-RUN-MVP.md`](./MANUAL-RUN-MVP.md). It includes a Node/TypeScript API, browser UI, file-backed Run/Event store, WebSocket live stream, deterministic demo runtime, and Pi SDK runtime path.

### Goal

Before Jira automation, manually start a Run and watch/control the Pi session from the UI.

### Backend tasks

- [x] Choose app stack and package layout: Node/TypeScript monolith for Phase 2.
- [~] Create persistence model for `runs`, `attempts`, `events`: file store for Phase 2, Postgres later.
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
- [ ] Add verifier command model: name, command, timeout, env policy, artifact policy.
- [x] Implement verifier runner outside Pi.
- [x] Capture stdout/stderr and exit codes.
- [x] Store verification results and redacted logs.
- [~] Display verifier results in the event stream; dedicated verifier panel still pending.
- [ ] Feed failed verifier summary into a bounded fix attempt.
- [ ] Add max fix attempt policy.
- [ ] Support e2e artifacts: screenshots, traces, videos where available.

### Exit gate

- [x] Manual Run transitions to `verifying` after the implementation runtime finishes.
- [x] Passing checks move Run to `completed`.
- [~] Failing checks create a clear event-stream failure; fix attempts still pending.
- [x] The agent cannot mark verification passed by itself.

## M4 — Source pickup: GitHub Issues and Jira

**Status:** `[~]` Config foundation in progress
**Type:** source integration  
**Inspired by:** Kandev Jira JQL watches, GitHub Issues for repository-scoped intake, but with external trackers kept as source of truth

### Goal

A GitHub issue or Jira issue matching configured readiness criteria creates exactly one TaskSmith Run.

### Tasks

- [~] Configure source credentials securely: GitHub CLI profile support is documented; Jira env/secrets still pending.
- [x] Define repository/source config: per-repo GitHub Issues or Jira metadata, git checkout URL, branch, verification profile, and Sandcastle-style workflow.
- [x] Define Jira watch config shape: `tasksmith` readiness label plus configurable label-to-repo routing.
- [ ] Implement Jira poller.
- [ ] Implement `jira_claims` unique claim table.
- [ ] Add claim/release/reconcile logic.
- [ ] Add Jira comment templates.
- [ ] Add Jira status/label transition config.
- [ ] Implement repository routing from Jira label/component/custom field.
- [ ] Handle missing repo route by creating `waiting_for_user` Run.
- [ ] Add UI for seeing Jira source metadata.

### Exit gate

- [ ] Jira issue with `tasksmith` creates one Run.
- [ ] Duplicate polling does not duplicate Run.
- [ ] Jira receives Run link comment.
- [ ] Jira status/labels reflect claimed/running/failed/pr-created.
- [ ] Repo routing works for GitHub Issues repos (`tasksmith`, `robodoggo`, `clui`) and Jira-routed repos (`vosime-admin`, `core-hub`).

## M5 — PR creation

**Status:** `[ ]` Not started  
**Type:** delivery integration  
**Inspired by:** CodeForge PR service, Kandev PR phase

### Goal

Turn verified changes into a draft PR and link it back to Jira.

### Tasks

- [ ] Decide first Git provider: GitHub only or GitHub + GitLab.
- [ ] Configure provider token storage.
- [ ] Implement safe branch naming.
- [ ] Implement commit author config.
- [ ] Detect changed files and empty diffs.
- [ ] Create branch from base branch.
- [ ] Commit changes.
- [ ] Push branch.
- [ ] Create draft PR.
- [ ] Generate PR body with Jira link, Run link, verification summary, review summary.
- [ ] Store PR metadata.
- [ ] Update Jira with PR link.

### Exit gate

- [ ] Verified Run produces draft PR.
- [ ] PR body has enough context for human review.
- [ ] Jira links to PR and TaskSmith Run.
- [ ] No auto-merge exists in MVP.

## M6 — Fresh-context review

**Status:** `[ ]` Not started  
**Type:** quality gate  
**Inspired by:** Kandev Review phase, CodeForge review task type

### Goal

A separate review pass checks the final diff before PR is marked ready.

### Tasks

- [ ] Define review prompt contract.
- [ ] Start review in separate Pi session/context.
- [ ] Provide diff, task requirements, and verifier result to reviewer.
- [ ] Require structured findings: severity, file, line, title, description, suggested fix.
- [ ] Store findings.
- [ ] Display review panel.
- [ ] Define block policy for severe findings.
- [ ] Optionally create fix attempt from findings.
- [ ] Include review summary in PR.

### Exit gate

- [ ] Implementation context is not reused for review.
- [ ] Review findings are structured and persisted.
- [ ] Severe findings block PR readiness or trigger fix.

## M7 — CI fixup

**Status:** `[ ]` Not started  
**Type:** post-PR automation  
**Inspired by:** Kandev CI Fixup phase, CodeForge webhook concepts

### Goal

After PR creation, TaskSmith watches CI checks and performs bounded fix attempts.

### Tasks

- [ ] Poll PR CI status.
- [ ] Fetch failed check logs.
- [ ] Summarize relevant failure output.
- [ ] Create CI fixup attempt in same workspace/branch.
- [ ] Push new commit.
- [ ] Re-poll CI.
- [ ] Stop after max attempts.
- [ ] Update Jira and UI on success/failure.

### Exit gate

- [ ] Failed CI produces one bounded fix attempt.
- [ ] Passing CI updates Run and Jira.
- [ ] Repeated failures stop safely with clear report.

## M8 — Hardening and internal beta

**Status:** `[ ]` Not started  
**Type:** production readiness

### Tasks

- [ ] Add Better Auth for UI/API before exposing a real public URL.
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
