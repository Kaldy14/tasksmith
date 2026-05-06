# ADR 0004: Run deterministic verification outside the agent

## Status

Proposed

## Context

Agents can decide to run checks, but TaskSmith needs reliable quality gates before PR creation. A prompt saying "run tests" is not equivalent to a deterministic verifier.

## Decision

TaskSmith will own verification as a separate subsystem. Repositories define explicit verification commands. The verifier runs after implementation attempts and before PR creation.

## Consequences

Positive:

- Quality gates are reproducible.
- Verification logs are structured and visible.
- Failed checks can drive fix attempts.
- PR creation can be blocked by policy.

Negative:

- Requires repository-specific configuration.
- Some e2e environments may be hard to run in sandbox.
- Verification can increase run time and infrastructure cost.

## Acceptance criteria

- [ ] Repo config declares verification commands.
- [ ] Verifier runs commands independently from Pi.
- [ ] Command output and exit code are persisted.
- [ ] Failed verifier output can be passed into a fix attempt.
- [ ] PR creation requires verification pass unless manually overridden.
