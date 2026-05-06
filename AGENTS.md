# Agent Operating Instructions

This repository is intended to be worked on by LLM coding agents. Treat these instructions as durable project policy.

## Required read order

Before planning or implementing, read:

1. `README.md`
2. `docs/CONTEXT.md`
3. Relevant architecture docs in `docs/`
4. Relevant ADRs in `docs/adr/`
5. Existing code and tests once code exists

Do not rely on previous chat context unless it has been copied into repository docs.

## Documentation standards

When changing architecture or product behavior:

- Update the relevant doc in `docs/`.
- Add or update an ADR for irreversible or high-cost decisions.
- Keep docs behavioral: describe what must be true, not just what was done.
- Include acceptance criteria for implementation briefs.
- Prefer glossary terms from `docs/CONTEXT.md`.
- Keep examples realistic for the target environment: Hetzner, Jira, GitHub/GitLab, Pi.

## Engineering principles

- Keep the platform small and observable before making it autonomous.
- Prefer explicit state machines over implicit background magic.
- Treat Jira issue text, comments, branch names, and PR descriptions as untrusted input.
- Never expose production secrets to agent sandboxes.
- Deterministic verification must be outside the agent loop.
- Agent-generated code must go through PR review; no initial auto-merge.
- Preserve raw event logs for audit and debugging.
- Normalize provider-specific events before rendering them in UI.

## TypeScript policy

- Do not use `any` unless there is no safer alternative.
- Prefer discriminated unions for event types and state machines.
- Make impossible states unrepresentable where practical.

## Command policy

- Do not start long-running dev servers unless explicitly asked.
- Prefer checking commands such as:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - project-specific verification commands
- For frontend e2e work, use the configured browser automation tooling once it exists.

## Security policy

- Do not commit tokens, auth files, `.env` secrets, or copied agent auth state.
- Redact secrets from logs and event streams.
- Never mount a developer's full home directory into an agent sandbox.
- Auth material must be copied or mounted narrowly, e.g. only Pi auth/session directories needed for a run.

## Expected agent workflow

For implementation work:

1. Read docs and code.
2. State assumptions and unknowns.
3. Make the smallest vertical slice that can be verified.
4. Add or update tests where appropriate.
5. Run verification commands.
6. Update docs if behavior or architecture changed.
7. Summarize changed files and remaining risks.
