# Roadmap

## Strategy

Build TaskSmith as thin vertical slices. Each slice should be end-to-end and demonstrable.

Do not start with a complex workflow builder. Start with one Jira watch, one repo, one Pi run, one verifier, one PR.

## Phase 0 — Project spike

Goal: prove Pi can run on Hetzner with persisted auth/session state.

Acceptance criteria:

- [ ] Pi installed on Hetzner.
- [ ] Pi authenticated via subscription auth.
- [ ] Pi can run in intended worker/sandbox environment.
- [ ] Pi session persists under a custom session dir.
- [ ] A test prompt can be steered/followed-up/aborted via SDK or RPC.

## Phase 1 — Manual run MVP

Goal: start a Run manually from UI/API and stream Pi events.

Acceptance criteria:

- [ ] Create Run with repo and prompt.
- [ ] Worker creates isolated workspace.
- [ ] Worker starts Pi via SDK/RPC.
- [ ] Events are stored in DB.
- [ ] UI streams events live.
- [ ] UI can send prompt/steer/follow-up/abort.
- [ ] UI can reconnect and replay history.

## Phase 2 — Deterministic verifier

Goal: run configured checks after Pi completes.

Acceptance criteria:

- [ ] Repo config supports verification commands.
- [ ] Verifier runs commands outside Pi.
- [ ] Logs are stored and displayed.
- [ ] Failed verification creates a fix attempt with logs.
- [ ] Verification pass/fail appears in UI.

## Phase 3 — Jira pickup

Goal: create Runs from Jira issues.

Acceptance criteria:

- [ ] Configure Jira credentials and JQL watch.
- [ ] Poller finds `ai-ready` issue.
- [ ] Poller claims issue idempotently.
- [ ] Run is created and linked to Jira key.
- [ ] Jira receives comment with run link.
- [ ] Missing repo route moves Run to `waiting_for_user`.

## Phase 4 — PR creation

Goal: convert verified changes into draft PR.

Acceptance criteria:

- [ ] Worker creates branch.
- [ ] Worker commits changes.
- [ ] Worker pushes branch.
- [ ] PR Creator opens draft PR.
- [ ] PR body contains Jira link, run link, verification summary.
- [ ] Jira receives PR link.

## Phase 5 — Independent review

Goal: fresh-context review before PR creation or before PR marked ready.

Acceptance criteria:

- [ ] Review uses separate session/context from implementation.
- [ ] Review reads diff and verification result.
- [ ] Review findings are structured by severity.
- [ ] Severe findings block PR or trigger fix attempt.
- [ ] Findings appear in UI and PR body.

## Phase 6 — CI fixup

Goal: poll CI and let Pi fix failures.

Acceptance criteria:

- [ ] PR CI status is polled.
- [ ] Failed logs are fetched.
- [ ] Fix attempt is created with CI logs.
- [ ] New commit is pushed.
- [ ] Loop stops at max attempts.

## Phase 7 — Hardening

Goal: make platform safe enough for broader internal use.

Acceptance criteria:

- [ ] Secret redaction tested.
- [ ] Sandbox isolation reviewed.
- [ ] Resource limits enforced.
- [ ] Audit logs retained.
- [ ] Auth/RBAC added for internal users.
- [ ] Backup/recovery plan documented.
