# Product

## Register

product

## Users

Internal engineering operators running an autonomous-coding control plane. They use TaskSmith from a desk monitor, in long sessions, while context-switching between Jira tickets, live agent runs, and code review. They are technical, opinionated, fast on keyboard. Their job-to-be-done is **watching agents do work and steering them when they go wrong** — not filling forms, not reading dashboards.

The primary task on any given screen is one of:
- Start a new run from a prompt or a Jira/GitHub issue.
- Watch a live agent session and read its tool calls, verifier output, and review findings as they stream in.
- Steer / follow-up / abort an in-flight agent without leaving the stream.
- Triage which of N parallel runs needs attention.

## Product Purpose

TaskSmith is a self-hosted control plane that turns issue-tracker tasks into verified, reviewable pull requests via autonomous coding agents (Pi-first). It exists because existing "AI PR" tools are opaque black boxes — TaskSmith makes the agent loop **observable, interruptible, and trustworthy** for a single engineering team.

Success looks like: an operator opens TaskSmith, sees at a glance what every agent is doing, and can intervene in any of them in under three seconds.

## Brand Personality

**Forged. Precise. Operator-first.**

Voice: confident, technical, never cute. Like a senior engineer's CLI tool that respects your time. The product is named TaskSmith and uses anvil/forge metaphors — lean into the industrial-craft register, but only where it earns its place. Not theme-park steampunk.

Emotional goals: **command** (the operator feels in control), **clarity** (live state is unambiguous), **earned trust** (the system shows its work — verifier output, review findings, raw events).

Aesthetic peers: Linear (density, opinionated keyboarding), Raycast (command-first minimalism), Claude Code / Cursor (conversational primary surface, agentic primitives). TaskSmith should sit comfortably next to those three on an engineer's desktop.

## Anti-references

Refuse on sight:

- **Jira / enterprise-tooling vibe.** Form-modal-form, gray buttons, cluttered toolbars. The product is supposed to replace Jira drudgery — it must never feel like Jira.
- **Generic SaaS dashboard.** Hero metric cards, identical icon-heading-text card grids, blue+purple gradient buttons, check-mark-in-a-circle illustrations.
- **Crypto / neon-on-black.** Glowing greens, terminal cosplay without substance, "matrix" rain.
- **AI-product cliché.** Purple-pink gradients, sparkle icons, floating orbs, glassmorphism for its own sake, "✨ AI" badges, hero-metric template.

## Design Principles

1. **Live state is the product.** The event stream is the protagonist, not chrome around it. Status, progress, and agent activity get the largest, boldest, most-saturated treatment. Everything else recedes.
2. **Start an action, don't decorate inaction.** The empty / home state must be an action surface (start a new run), never a passive placeholder. No "Pick a thread from the sidebar" copy.
3. **One committed accent does the heavy lifting.** Heat (the existing forge-orange token) is not a 5% accent — it carries identity, focus states, active runs, primary CTAs. Jade marks completion, copper marks in-progress work, steel marks information. No timid neutral monochromes.
4. **Type does hierarchy, not decoration.** Readable body (≥14px for primary text, ≥13px for secondary), strong scale jumps between levels, no 10–11px text outside genuine metadata captions. Mono for IDs, code, sequences, and timing only.
5. **Density with breathing room.** Operator-grade information density (peer with Linear/Raycast), but rhythm and grouping make it scannable. Cards only when they earn the visual weight; mostly: typographic separation and vertical rhythm.

## Accessibility & Inclusion

- Target WCAG AA. Body text contrast ≥4.5:1 against `--background`. Status colors (heat / jade / copper / destructive) must remain distinguishable to red-green and blue-yellow color-vision deficiencies — pair every color signal with an icon or label.
- Full keyboard navigation: every primary action (new run, send, abort, switch thread) must be reachable without a mouse, with discoverable shortcuts visible in the UI.
- Respect `prefers-reduced-motion` — pulsing live indicators must degrade to a solid dot.
- Single dark theme is intentional (operator desk-monitor usage); no light mode in scope.
