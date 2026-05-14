# UI Redesign — Implementation Brief

This is a self-contained handoff for the **TaskSmith web UI overhaul**. A future agent should be able to read this alongside [`/PRODUCT.md`](../PRODUCT.md) and [`/DESIGN.md`](../DESIGN.md) and implement the entire redesign without needing the conversation that produced it.

**Status:** design approved, implementation not started.
**Approved by:** repository owner (2026-05-14).
**Approach used:** `/impeccable` workflow — register confirmed as `product`, full shell overhaul scope, committed-heat color strategy, `/` becomes the empty new-chat surface.

---

## 1. Why this redesign

The current web UI (under `src/web/src/`) works functionally but has accumulated UX flaws that block it from feeling like the operator-grade tool described in PRODUCT.md:

1. **"New chat" is a sidebar popup.** Pressing `+` toggles an inline `IntakeForm` crammed into a 296px-wide sidebar with `h-8 text-[0.78rem]` fields. The owner explicitly flagged this as the worst current UX flaw.
2. **`/` is a passive dead-end.** Home route renders `EmptyAnvil` with copy "Pick a run from the sidebar or start a new one from Projects" — it tells the user where to go instead of *being* a place to act.
3. **Text-size soup.** `text-[11px]`, `text-[10px]`, `text-[0.78rem]`, `text-[0.72rem]` litter the codebase. Primary content drops below the readable floor. PRODUCT.md targets engineering operators on 27" monitors — they should read *less*, not squint *more*.
4. **Cramped Anvil header.** Six different pills (title, repo, source, PR, status, refresh/abort) compete in a 56px-tall row. Nothing reads at a glance.
5. **Color is timid.** `--primary` is blue (`oklch(0.59 0.2 264)`). The named brand color `--heat` exists but is barely used. The forge metaphor in the product name is unsupported by the design.
6. **Duplicate connection indicators.** Sidebar footer, Anvil footer, and an orphaned `Masthead` component all surface "connection" state independently.
7. **`Masthead` is dead code.** Defined in `src/web/src/components/masthead.tsx`; not rendered anywhere in `router.tsx`.

These are documented in PRODUCT.md as anti-references (Jira-ish, generic SaaS) and design principles (Live state is the product; Type does hierarchy, not decoration).

---

## 2. Approved design brief (do not re-decide these)

These were confirmed by the repository owner during the impeccable shape interview. Do not re-shape:

- **Register:** `product` (internal control plane, not marketing).
- **Brand personality:** *Forged. Precise. Operator-first.* Between "forge/industrial" and "terminal-native."
- **Anchor references:** Linear, Raycast, Claude Code / Cursor.
- **Anti-references:** Jira / enterprise tooling, generic SaaS dashboard, crypto neon-on-black, AI cliché.
- **Color strategy:** **Committed.** One color (heat) carries 25–40% of attentive surface as identity. Jade = completion, copper = active work, steel = info, destructive = errors. No timid neutral monochromes.
- **Scene sentence (drives theme):** *"Engineer at a 27-inch monitor at 11pm in a dim home office, juggling Jira, three live agent runs, and a code review, wanting to see at a glance which run needs them now."* → dark theme, high-confidence contrast, no glass.
- **Scope:** Full shell overhaul, production-ready, single coherent pass. Login UI logic and API/hooks untouched.
- **New-chat topology:** `/` IS the empty new-chat surface (option 1, recommended). No dedicated `/new` route. No modal. The sidebar `+` button becomes a `Link to="/"`.

Image-direction probes were **skipped** — the Claude Code harness used during shape did not have a native image generation tool. Visual decisions were therefore made in code-spec form via DESIGN.md.

---

## 3. Files to change

Paths are relative to repo root. Items marked **NEW** are new files. **DELETE** items are removed.

### 3.1 Foundation (do these first)

| File | Change |
|---|---|
| `src/web/src/index.css` | Replace token block with the values in DESIGN.md §1.1, §1.4, §1.6. Add `--copper`, `--steel`, `--heat-glow`, `--heat-muted`, `--surface-1`, `--surface-2`, `--border-strong`, `--subtle-foreground`, `--ease-out`, `--duration-*`. Point `--primary` at `var(--heat)` and `--primary-foreground` at the forge-charcoal value. Add `@media (prefers-reduced-motion: reduce)` block disabling pulses and shortening transitions. Keep the existing `body::after` noise overlay — it is on-brand. Update scrollbar color to use a warmer tint (`oklch(1 0 0 / 0.12)`). Update selection background to `var(--heat-muted)`. |
| `src/web/src/components/ui/button.tsx` | After `--primary = --heat`, the `heat` variant is redundant. Either delete it and update callers to use `default`, **or** keep the alias for back-compat but make it identical to `default`. Recommended: delete and update three call sites in `intake-form.tsx`, `config-page.tsx`, `home-hero.tsx` (NEW). Add `xl` size if not already present (h-12 px-7) — used by the hero send button. |
| `src/web/src/components/ui/badge.tsx` | Add `working` variant (`border-copper/40 bg-copper/10 text-copper`) and an `attention` variant (`border-heat/45 bg-heat/12 text-heat`). Keep existing `running/completed/failed/waiting/queued` but consider unifying — see `status-pill.tsx` change. |
| `src/web/src/components/ui/textarea.tsx` | Bump base font from `text-[0.95rem]` to `text-base` (15px). |

### 3.2 Shell & navigation

| File | Change |
|---|---|
| `src/web/src/router.tsx` | `HomeRoute` no longer renders `Anvil` with undefined runId. Instead render the new `<HomeHero />`. Remove `onConnectionChange` / `onActivity` wiring from the home route (no stream on `/`). Sidebar still uses the shell context for `refreshRuns` after a new run is created. Connection-state context becomes scoped: only `RunRoute` updates `setConnection`; home and config force `setConnection("idle")` in an effect. |
| `src/web/src/App.tsx` | No change. |
| `src/web/src/components/masthead.tsx` | **DELETE.** No call sites. Verified via `grep -rn "Masthead" src/web/src/`. |

### 3.3 Sidebar

`src/web/src/components/project-rail.tsx` — substantive rewrite, retaining the existing data model:

- Width `w-[272px]`.
- Header band (h-14): forge mark + `TaskSmith` wordmark linking to `/`. Same mark used in login page.
- "Projects" section header: `text-caption` uppercase, `+` icon is now a `<Link to="/" aria-label="Start a new run">` — no more `useState` toggle, no more inline `IntakeForm`.
- **Delete** the inline `<IntakeForm />` render block and its `showIntake` state. The IntakeForm component itself is repurposed into HomeHero — see §3.4.
- Project group header rows: `h-9`, full-row toggles collapse. Live-count badge uses `--heat-muted` when `liveCount > 0`, muted otherwise.
- Thread rows (`ThreadRow`): bump to `h-9`, `text-sm`. Status dot follows the StatusPill color logic (DESIGN.md §2.2). Active row: 2px `--heat` left rail (`before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-heat before:rounded-full`) plus `bg-surface-2` (or current `--accent`). Timestamp always visible (not hover-only) in `text-caption text-subtle-foreground`.
- Footer cluster: three rows separated by `border-t border-border`. Order top to bottom: SessionSummary (if auth) → `/config` link → connection chip. The connection chip is the *only* place connection state shows.

### 3.4 Home (new chat)

**NEW** `src/web/src/components/home-hero.tsx`:

- Centered column, `max-w-2xl mx-auto pt-20 pb-24 px-6`.
- Top block: brand mark (`size-12` heat-tinted square with `Flame` icon, `--heat`), wordmark `text-display`, tagline `text-base text-muted-foreground` reading exactly: `Forge tasks into reviewable PRs.`
- Headline below: `text-h2 text-foreground` reading `Start a run.`
- Hero card (elevation level 2 per DESIGN.md §1.5):
  - Row 1: repo Select + adapter Select side-by-side, `text-sm`. Repo list pulled from `getPublicConfig()` like the current `IntakeForm`.
  - Row 2: prompt `Textarea`, `text-base`, `rows={5}`, placeholder `Describe the change. Link a Jira or GitHub issue. Or both.`
  - Row 3: optional title `Input` (slim, single-line) on the left, `⌘↵` kbd hint center, send button on right (`size="xl"`, `variant="default"` which is now heat, `rounded-full`, `ArrowUp` icon, `aria-label="Start run"`).
- Below card: a horizontal strip of last 6 runs as compact chips: `<status-dot> <title 24ch truncate>`, navigates to `/runs/$id` on click. Header for the strip: `Recent` in `text-caption uppercase`. Show only if `runs.length > 0`.
- First-visit empty state (`runs.length === 0`): replace the recent strip with one quiet line `Your runs will land here.` in `text-sm text-subtle-foreground`. No fake demo prompts.

The HomeHero **reuses the API** that `IntakeForm` calls today: `createRun({ title, repoKey, adapter, prompt })`, then `navigate({ to: "/runs/$runId", params: { runId } })`. After successful navigation, call `onCreated` so the sidebar refreshes.

**Delete or repurpose** `src/web/src/components/intake-form.tsx`. Recommended: delete and inline its logic into `home-hero.tsx`. The current `IntakeForm` is only consumed by the sidebar popup which is going away.

### 3.5 Run view

`src/web/src/components/anvil.tsx`:

- Replace the single `<header>` with two stacked rows inside a wrapper.
- **Row 1** (`h-14 px-6 border-b border-border bg-surface-1`):
  - `<h1 className="text-h1 truncate">` the run title.
  - Right side: `<StatusPill>`, then refresh ghost icon button, then abort ghost icon button (destructive treatment on hover only).
- **Row 2** (`h-10 px-6 border-b border-border bg-background flex items-center gap-2`):
  - Repo chip: `text-caption uppercase` with folder icon, no border, just `bg-accent rounded-md`.
  - Source chip (if `run.source`): same chip + external-link icon if URL present, click opens in new tab.
  - PR chip (if `run.pullRequest`): jade-tinted variant.
  - `ml-auto` right group: `text-mono text-subtle-foreground` showing `{shortId(run.id)} · {formatRelativeTime(run.updatedAt)}`.
- Error band: stays, push width to full and slightly larger type (`text-sm`).
- Event stream wrapper: bump `max-w-[960px]` → `max-w-[1024px]`. Vertical padding `py-6`.
- Composer wrapper: same `max-w-[1024px]`. Outer wrapper padding `px-6 pb-4 pt-2`.
- **Remove** the footer connection indicator block (`<Folder> Local checkout` and `<SquareTerminal> ... events <PanelRight> connection`). Connection state is owned by the sidebar. Event count can move into Row 2 as `events · {count}` mono caption if desired, but is optional — sidebar's live indicator already implies activity.
- `EmptyAnvil` (`runId === undefined`): unreachable after router changes — the home route now renders `HomeHero` instead. **Delete `EmptyAnvil`.**

### 3.6 Composer

`src/web/src/components/control-bar.tsx`:

- Outer: `rounded-2xl border border-border bg-surface-1 p-px`. Focus-within: `border-heat/70` + `shadow-[0_0_0_1px_var(--heat-glow)]`.
- Inner: `bg-surface-2 rounded-[19px]`.
- Textarea: `text-base` (15px), `min-h-24 max-h-48`, no border, no ring (parent owns the seam).
- Controls row: Select for control-kind on left, then dot separator, then runtime badge (`Bot` icon + `Pi runtime` / `Demo runtime`), then sandboxed badge (`ShieldCheck` icon).
- Right side: `⌘↵` kbd hint in `text-mono-xs text-subtle-foreground`, then send button (`size="default" variant="default"` icon-only, `rounded-full`, `ArrowUp`, `aria-label="Send message"`).
- Reduced-motion: focus-within transitions to `1ms`.

### 3.7 Event stream

`src/web/src/components/event-stream.tsx`:

- Bump max-width owner is the parent (Anvil), so just remove any constraints here.
- Empty state inside the stream: `text-base text-subtle-foreground` (up from `text-sm text-muted-foreground/35`).
- Keep `compactAssistantDeltas` as-is.

`src/web/src/components/event-card.tsx`:

- **Assistant message**: prose `text-base` (15px) `leading-7`. Bot icon + time in `text-caption text-subtle-foreground`. No background, no border. Tight `py-3`.
- **User message**: right-aligned bubble. `max-w-[80%] rounded-2xl rounded-br-md bg-heat-muted border border-heat/25 px-4 py-3`. Body `text-base leading-6`. Meta row `text-caption text-heat/70` with MessageSquare icon and control label.
- **Work events** (`isWorkEvent` set): outer `rounded-lg border border-border bg-surface-1 px-4 py-3`. Header row: role-colored icon chip (`size-6 rounded-md bg-{role}-muted text-{role}`) + label `text-caption uppercase tracking-wide` + mono sequence right-aligned in `text-mono-xs text-subtle-foreground`. Body `text-mono` (13px) `leading-5`, `max-h-72 overflow-auto`. Role color resolution:
  - `tool_call`, `command`, `command_output` → copper
  - `tool_result` → jade
  - `verification`, `review`, `delivery`, `ci` → derive from `data.status`: passed/created/completed/pr_created → jade, running → copper, failed → destructive
  - `queue_update`, `session_state` → steel
- **Error events**: `rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3`. Heading `text-sm font-medium text-destructive` with `CircleAlert`. Body `text-mono text-destructive leading-5`.
- **Divider events** (e.g., `attempt_done`): horizontal rule + pill caption. Pill jade if `attempt_done.status === "completed"`, destructive if `failed`/`aborted`, muted otherwise.

### 3.8 Status pill

`src/web/src/components/status-pill.tsx`:

- Replace the `STATUS_TO_VARIANT` map so working states map to a new `working` variant (copper), `waiting_for_control` maps to `attention` (heat), completed/pr_created → `done` (jade), failed/cancelled → `failed` (destructive), queued stays `queued` (muted).
- Update the dot color logic accordingly.
- Wrap the pulse class in a `@media (prefers-reduced-motion: no-preference)` check, or use Tailwind's `motion-safe:animate-pulse` so reduced-motion users get a solid dot.

### 3.9 Config page

`src/web/src/components/config-page.tsx`:

- Header: match Anvil row 1 — `h-14 px-6`, `text-h1` title `Project configuration`, subtitle `text-sm text-muted-foreground`.
- Cards: use elevation level 2.
- Body copy in reference cards: bump from `text-[11px]`/`text-xs` mixes to a clean `text-sm` baseline. Code samples stay `text-mono`.
- "Set TASKSMITH_CONFIG_PATH" hint card: stays heat-tinted (it is an action-needed signal — heat is correct).

### 3.10 Login

`src/web/src/components/login-page.tsx`:

- Replace `Hammer` icon with `Flame` (matches the forge brand mark used everywhere else).
- Icon container: `bg-heat-muted text-heat` (was `bg-primary/15 text-primary` — primary changes mean this would auto-shift, but explicit is better).
- Card: bump body copy to `text-sm`, tighten card spacing. Optional.

---

## 4. States to design and verify

For each surface, the following states must look intentional. Treat any state that looks like an afterthought as a P0 defect.

### 4.1 `/` home (new chat)

| State | Description |
|---|---|
| First visit (0 runs) | Hero + "Your runs will land here." line. No recent strip. |
| Has runs | Hero + horizontal strip of last 6 runs as chips. |
| Submitting | Send button shows `Loader2` spinner, all inputs disabled. |
| Error (createRun fails) | Inline error band below the card, destructive treatment, `text-sm`. Does not navigate. |
| No repos configured | Repo Select shows a disabled "No repositories configured" item; submit disabled with a tooltip pointing to `/config`. |

### 4.2 `/runs/$runId`

| State | Description |
|---|---|
| Loading (initial) | Row 1 shows skeleton (title placeholder), row 2 empty, event stream shows the configured `emptyHint`. Composer disabled. |
| Connecting | StatusPill shows `claimed` or `preparing` with copper pulse. |
| Running | StatusPill copper pulse. Event stream auto-scrolls. |
| Waiting for control | StatusPill **heat** pulse (the one moment heat means "you, now"). Composer enabled. |
| Verifying / Reviewing / Delivering / Creating PR | StatusPill copper pulse with the exact label. |
| Completed / PR created | StatusPill jade solid (no pulse). PR chip prominent in row 2 if present. Composer disabled. |
| Failed | StatusPill destructive solid. Destructive band immediately under header showing `run.error` text. Composer disabled. |
| Cancelled | Same as Failed but copy reads "cancelled" not "failed." |
| Offline (websocket dropped) | Sidebar connection chip flips to destructive. Row 2 may show an inline reconnect indicator (optional). |

### 4.3 Sidebar

| State | Description |
|---|---|
| No runs yet | Below "Projects" header, single line `No threads yet — start one above.` Heat link arrow. |
| Loading runs | Skeleton rows (3 placeholder thread rows). |
| Many runs | Project groups collapse-by-default if collapsed flag is set; otherwise scroll-area handles overflow. Live runs always sort to the top within a project group. |
| Auth on | SessionSummary row visible above config link. |
| Auth off | SessionSummary hidden, config link sits directly above connection chip. |

---

## 5. Copy

Final, approved microcopy. Use verbatim. No emoji. No sparkles. No exclamation marks.

| Surface | Element | Copy |
|---|---|---|
| HomeHero | Tagline | `Forge tasks into reviewable PRs.` |
| HomeHero | Headline | `Start a run.` |
| HomeHero | Prompt placeholder | `Describe the change. Link a Jira or GitHub issue. Or both.` |
| HomeHero | Title placeholder | `Title (optional)` |
| HomeHero | Submit button | `Start run` (or icon-only with aria-label `Start run`) |
| HomeHero | First-visit subline | `Your runs will land here.` |
| HomeHero | Recent strip header | `Recent` |
| Sidebar | Section header | `Projects` |
| Sidebar | Empty state | `No threads yet — start one above.` |
| Sidebar | Config link | `Project config` |
| Sidebar | New-run button | `aria-label="Start a new run"` |
| Anvil | Refresh | `aria-label="Refresh run"` |
| Anvil | Abort | `aria-label="Abort run"` |
| Composer | Placeholder | `Ask anything, @tag files/folders, or use / to show available commands` (unchanged from current) |
| Composer | Send | `aria-label="Send message"` |
| ConfigPage | Title | `Project configuration` |
| ConfigPage | Subtitle | `{response?.path ?? "No TASKSMITH_CONFIG_PATH configured"}` (unchanged) |
| LoginPage | Title | `Sign in to TaskSmith` (unchanged) |

---

## 6. Acceptance criteria

A future implementation pass is **done** when all of these are demonstrably true:

1. `/` renders the HomeHero with brand mark, headline, hero card, and (when runs exist) recent strip. There is no inline IntakeForm anywhere in the sidebar.
2. The `+` button in the sidebar is a `<Link to="/">`, not a state toggle.
3. The Anvil run view has two visually distinct header rows (h-14 over h-10).
4. `--primary` resolves to the heat OKLCH value. The hero send button and any element using `bg-primary` reads as heat-orange. No element renders as the old `oklch(0.59 0.2 264)` blue.
5. No primary-content text in the running app uses `text-[10px]` or `text-[11px]`. Allowed exceptions are limited to: event sequence counters, `⌘↵` kbd hints. Grep `text-\[10px\]` and `text-\[11px\]` to verify.
6. Status pills render: copper for working states, **heat for `waiting_for_control` only**, jade for `completed`/`pr_created`, destructive for `failed`/`cancelled`, muted for `queued`.
7. The only connection-state indicator is in the sidebar footer.
8. `src/web/src/components/masthead.tsx` and `src/web/src/components/intake-form.tsx` are deleted; no dead imports remain.
9. `pnpm typecheck` and `pnpm typecheck:web` pass.
10. `pnpm build` succeeds.
11. Reduced-motion: with `prefers-reduced-motion: reduce`, status dots do not pulse and transitions are ≤1ms. Verifiable in browser devtools "Emulate CSS prefers-reduced-motion" toggle.
12. Manual smoke: create a run from `/`, watch it stream events, send a steer message, abort it. No console errors. No layout shift on header row 1 ↔ row 2 boundary.

## 7. Non-goals (do not do these in this pass)

- Do not introduce a `/new` route. `/` is the new-chat surface.
- Do not introduce a command palette (`⌘k`). The shortcut is reserved but not bound.
- Do not change `src/web/src/api.ts` or any hook (`use-run-stream.ts`, `use-runs.ts`). UI-only pass.
- Do not change the websocket protocol, the event store shape, or backend code.
- Do not introduce a light theme.
- Do not introduce new icon libraries. Lucide-only.
- Do not add analytics, telemetry, or auth-flow changes.
- Do not refactor the router beyond the single change in §3.2.
- Do not add empty/error states for screens not enumerated in §4.

---

## 7.5 Available primitives (use these — do not re-build)

The previous session completed tokens, primitive components, and reusable display components. The page rewrites below should **compose** these — do not redefine them.

**Tokens & utilities** (`src/web/src/index.css`)
- Color tokens: `--heat`, `--heat-muted`, `--heat-glow`, `--copper`, `--jade`, `--steel`, `--surface-1`, `--surface-2`, `--border-strong`, `--subtle-foreground`. Use as `bg-heat`, `text-copper`, `border-border-strong`, `text-subtle-foreground`, etc.
- Type scale: `text-mono-xs` (11px), `text-caption` (12px), `text-sm` (13px), `text-base` (15px), `text-h2` (17px), `text-h1` (22px), `text-display` (28px). `--primary` already points at `--heat`.
- Utilities: `tracking-caption` (caption letter-spacing), `text-balance`, `ring-heat`. Global `prefers-reduced-motion` rule already disables animations — use Tailwind `motion-safe:` prefixes for new pulses.

**UI primitives** (`src/web/src/components/ui/`)
- `Button` — `variant="heat"` is the forge button (glow ring, active press), `variant="default"` resolves to heat as well; `size="xl"` is h-12 for the hero send. `size="icon"` + `rounded-full` for compact icon buttons.
- `Badge` — variants: `working` (copper), `attention` (heat), `running` (steel), `completed` (jade), `failed`, `waiting`, `queued`. Use `working`/`attention` for new code; `running`/`waiting` stay for `StatusPill` back-compat.
- `Textarea` — heat focus ring, surface-1 base, text-base baseline.
- `Kbd` (NEW) — `<Kbd>⌘↵</Kbd>` for keyboard hint chips. Used in HomeHero hero card and ControlBar.
- `SectionLabel` (NEW) — uppercase caption with optional `trailing` slot. Use for "Projects", "Recent", section headers.
- `Chip` (NEW) — generic chip for Anvil Row 2 and elsewhere. Props: `tone` (muted/jade/heat/copper/steel/destructive), `icon` (ReactNode), `href` + `external` for source links, `children` for the label. Renders as `<a>` when `href` is set, otherwise `<span>`.
- `PageHeader` + `PageTitle` (NEW) — the two-row header shell from §3.5. `<PageHeader primary={...} secondary={...} />`. Row 1 = h-14 surface-1; Row 2 = h-10 background. Pass `<PageTitle title="..." subtitle="..." />` plus action buttons into `primary`. Omit `secondary` for ConfigPage's single-row header.

**Reusable display components** (`src/web/src/components/`)
- `BrandMark` (NEW) — heat-tinted Flame square. Sizes `sm`/`md`/`lg`. Use in `HeroShell` (auto), ProjectRail header, LoginPage.
- `HeroShell` + `HeroCard` (NEW) — centered column for `/`. `HeroShell` lays out brand mark, wordmark, tagline, headline. `HeroCard` is the elevation-2 surface wrapping the form. Just supply form rows as children.
- `RunChip` + `RunChipStrip` (NEW) — compact pill linking to `/runs/$runId` with status dot. `RunChipStrip` handles the horizontal scroll + fade-mask for the "Recent" strip on `/`. Slices to first 6 automatically.
- `ConnectionChip` (NEW) — sidebar footer state pill. Props: `state` (`"idle" | "connecting" | "connected" | "disconnected"`). Single source of truth for connection display per acceptance criterion #7.
- `StatusPill` — re-mapped per §3.8 (working→copper, attention→heat for `waiting_for_control`, completed/pr_created→jade, failed/cancelled→destructive). Uses `motion-safe:animate-pulse`.
- `EventCard`, `EventStream`, `ControlBar` — already styled per §3.6–§3.7. Don't restyle; just embed.

## 8. Suggested implementation order

For a clean, reviewable diff:

**Done in prior session (do not redo):**

1. ~~**Tokens & primitives**~~ — `index.css`, `button.tsx`, `badge.tsx`, `textarea.tsx`. ✅
2. ~~**StatusPill** re-map~~. ✅
3. ~~**EventCard typography**~~. ✅
4. ~~**Composer (ControlBar)** typography and seam~~. ✅
5. ~~**EventStream empty state**~~. ✅
6. **Page-level primitives created**: `BrandMark`, `Kbd`, `SectionLabel`, `Chip`, `PageHeader`/`PageTitle`, `HeroShell`/`HeroCard`, `RunChip`/`RunChipStrip`, `ConnectionChip`. ✅

**Remaining for this session:**

7. **HomeHero (new file) + router wiring** — replace `EmptyAnvil` path on `/`. Compose `HeroShell` + `HeroCard` + `RunChipStrip`. Reuse `IntakeForm` create-run logic inline.
8. **ProjectRail rewrite** — bigger rows, no popup, footer cluster. `+` becomes `<Link to="/">`. Use `BrandMark` for the wordmark area, `SectionLabel` for "Projects", `ConnectionChip` in the footer.
9. **Anvil header restructure** — compose `<PageHeader primary={...} secondary={...} />`. Use `Chip` for repo / source / PR. Use `PageTitle` + `StatusPill` + ghost icon buttons in `primary`. Remove footer connection block.
10. **Delete `masthead.tsx`, delete `intake-form.tsx`, delete `EmptyAnvil`.**
11. **ConfigPage + LoginPage polish** — `PageHeader` (single row, no secondary) for ConfigPage; swap `Hammer` → `BrandMark` in LoginPage.
12. **Typecheck, build, manual browser smoke.** Verify reduced-motion. Capture screenshots of every state listed in §4 for the PR description.

Each numbered step should be a single commit when possible. The final state should pass every item in §6.

---

## 9. Open questions to resolve during implementation

These were left open during shape because they are minor enough to be implementer decisions:

- **Recent-strip horizontal scroll affordance.** Visible scrollbar vs. fade-mask edges vs. paginate buttons. Recommend fade-mask with `mask-image: linear-gradient(...)` — minimal and on-brand.
- **Hero card title field placement.** Currently designed as a slim row alongside the send button. If it crowds the kbd hint, move it above the prompt textarea as its own row.
- **Reduced-motion implementation style.** Use Tailwind `motion-safe:` / `motion-reduce:` prefixes consistently rather than CSS `@media` blocks where possible.
- **`prefers-color-scheme: light`.** Out of scope for this redesign, but if a future agent adds light mode, the OKLCH tokens make symmetric L/C/H pairs straightforward — do not hand-pick light-mode colors without re-running the impeccable shape interview.

---

## 10. References

- [`/PRODUCT.md`](../PRODUCT.md) — strategic context, users, voice, anti-references, design principles.
- [`/DESIGN.md`](../DESIGN.md) — visual system spec (tokens, type, components, motion, a11y).
- [`/AGENTS.md`](../AGENTS.md) — agent operating rules; this redesign is consistent with the engineering principles ("keep platform small and observable", "TypeScript: no `any`").
- [`docs/EVENTS-AND-UI.md`](EVENTS-AND-UI.md) — durable contract for how events render. The redesign respects all behaviors documented there.
- impeccable references useful during the implementation pass: `typography.md`, `color-and-contrast.md`, `spatial-design.md`, `interaction-design.md`, `motion-design.md` (under `~/.claude/skills/impeccable/reference/`).
