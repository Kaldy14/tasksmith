# Design

This document is the visual system for TaskSmith's web UI. Read alongside [`PRODUCT.md`](./PRODUCT.md), which carries the strategic context (users, voice, anti-references, design principles). PRODUCT.md says *what* and *why*; DESIGN.md says *how it looks*.

The system is **forge-tempered terminal**: operator-grade density with the confidence of an industrial-craft brand. One committed accent (heat / forge-orange) carries identity. Status colors are dedicated, never decorative. Type does the heavy lifting on hierarchy.

---

## 1. Foundations

### 1.1 Color tokens

All colors are OKLCH. Neutrals are tinted slightly toward the heat hue (~65°) to prevent dead grey. No pure `#000` / `#fff`. Chroma reduces near 0 and 100 lightness. **Single dark theme** — light mode is intentionally out of scope (operator desk-monitor usage; see PRODUCT.md §Accessibility).

#### Surface scale (dark, only theme)

| Token | Value | Role |
|---|---|---|
| `--background` | `oklch(0.135 0.008 65)` | App background. Slightly warmer than the current near-neutral. |
| `--surface-1` | `oklch(0.165 0.008 65)` | Sidebar, header bands, secondary surfaces. Replaces `--card` in most use. |
| `--surface-2` | `oklch(0.195 0.009 65)` | Cards that sit on `--surface-1` (rare; cards are not the default). |
| `--card` | `var(--surface-1)` | Back-compat alias. New code prefers `--surface-1` or `--surface-2`. |
| `--popover` | `oklch(0.185 0.008 65)` | Floating overlays, selects, command-K. |
| `--border` | `oklch(1 0 0 / 0.085)` | Default seam. |
| `--border-strong` | `oklch(1 0 0 / 0.16)` | Hover and focus seams; emphasis on group headers. |
| `--input` | `oklch(1 0 0 / 0.11)` | Form field border. |

#### Foreground scale

| Token | Value | Role |
|---|---|---|
| `--foreground` | `oklch(0.965 0.004 65)` | Primary text. Bumped from 0.94 for contrast against new `--background`. |
| `--muted-foreground` | `oklch(0.68 0.008 65)` | Secondary text, captions, sidebar subtitles. ≥4.5:1 against `--background`. |
| `--subtle-foreground` | `oklch(0.52 0.008 65)` | Tertiary metadata only (event sequence, IDs, timestamps). Never primary copy. |

#### Brand & role colors

| Token | Value | Meaning. Used for: |
|---|---|---|
| `--heat` | `oklch(0.72 0.175 60)` | **Identity.** Primary CTA, brand mark, focus ring, active thread rail, waiting/needs-attention status. The committed color — must carry 25–40% of attentive surface. |
| `--heat-glow` | `oklch(0.72 0.175 60 / 0.42)` | Soft glow / shadow on focused / live elements. |
| `--heat-muted` | `oklch(0.72 0.175 60 / 0.14)` | Tinted background fill for heat-toned chips and rails. |
| `--copper` | `oklch(0.72 0.14 45)` | **Active work.** Tool calls, commands, command output, running-but-not-attention statuses (`running`, `verifying`, `fixing`, `reviewing`, `claimed`, `preparing`, `watching_ci`, `delivering`, `creating_pr`). Reads as "hot in the forge but not yet needing you." |
| `--jade` | `oklch(0.74 0.135 160)` | **Completion.** Verifier pass, review pass, PR created, run completed, tool results. |
| `--steel` | `oklch(0.68 0.13 254)` | **Information.** Sessions, queue updates, neutral system events. Never primary; subordinate to heat. |
| `--destructive` | `oklch(0.66 0.215 25)` | **Error / abort.** Failed runs, abort button hover, error bands. Reserved. |
| `--primary` | `var(--heat)` | The primary token IS heat. Old blue primary is retired. |
| `--primary-foreground` | `oklch(0.16 0.018 65)` | Dark forge-charcoal text that sits on heat backgrounds. |

#### Color discipline rules

1. **Heat is identity, not a status.** Heat is for the brand mark, the primary CTA, the focus ring, the active thread, and `waiting_for_control` (the one status where you *are* the agent's blocker). Use it sparingly enough that it still feels like an event.
2. **One color = one meaning.** Copper is *only* active work. Jade is *only* completion. Steel is *only* information. A reader should be able to glance at a status pill or event tag and know what category it belongs to.
3. **Always pair color with icon or label.** No color-only signals (a11y for color-vision deficiencies — see PRODUCT.md).
4. **Neutrals are tinted.** No pure greys. The `chroma 0.008 at hue 65` tint keeps the surface family coherent with the heat accent.

### 1.2 Typography

#### Font stack

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", Consolas, ui-monospace, monospace;
```

Inter and JetBrains Mono are *aspirational* — if not loaded, the existing system stack remains as fallback. If a font-loading strategy is added, prefer `font-display: swap` with WOFF2.

#### Type scale

| Class / token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-display` | `28px / 36px` | 600 | Home headline ("Start a run."), big empty-state titles. |
| `text-h1` | `22px / 30px` | 600 | Run title in the header band. |
| `text-h2` | `17px / 26px` | 600 | Section heads (Recent threads, Project config). |
| `text-base` | `15px / 24px` | 400 | **Primary body and assistant message text.** ≥15px is the floor — no exceptions. |
| `text-sm` | `13px / 20px` | 400 | Secondary text, thread row, project group headers, sidebar copy. ≥13px is the floor for anything readable. |
| `text-caption` | `12px / 18px` | 500 | UPPERCASE labels, badge text, timestamps when used as captions. Tracking `0.04em`. |
| `text-mono` | `13px / 20px` | 500 (mono) | Code, command output, sequences, IDs, kbd shortcuts. |
| `text-mono-xs` | `11px / 16px` | 500 (mono) | Sequence numbers ONLY. Permitted exception below the 13px floor. |

**Floor rule.** Never put primary content below `text-sm` (13px). The 10–11px sizes currently scattered through the app are an anti-pattern. The only places `text-mono-xs` (11px) is allowed: the per-event `sequence` counter, and shortcut kbds in chrome (which already carry an icon affordance).

**Hierarchy ratio.** Each step is ≥1.25× the next — `28 → 22 → 17 → 15 → 13 → 12`. No flat scales.

**Mono only for what is structurally code.** Command, command output, file paths, sequence numbers, kbd glyphs, raw event JSON, IDs. Run titles, statuses, and chrome are sans.

#### Letter-spacing

- Display / h1 / h2: `tracking-tight` (`-0.011em`).
- Body: default tracking.
- Caption: `tracking-wide` (`0.04em`) — wider than current 0.16em, which reads as decorative. UPPERCASE captions stay tightish for readability.

### 1.3 Spacing & rhythm

Tailwind's 4-unit base. Component padding is intentional, not default.

| Use | Padding |
|---|---|
| Sidebar gutter | `px-3` (12px) |
| Sidebar row | `h-9` with `px-2.5` |
| Run-view header band, row 1 | `h-14 px-6` |
| Run-view header band, row 2 | `h-10 px-6` |
| Event card (work events) | `px-4 py-3` |
| Event card (assistant) | `px-1 py-4` (typographic, no chrome) |
| Composer outer | `p-px` (border seam) |
| Composer inner | `px-5 pt-4 pb-3` |
| Home hero | `pt-20 pb-24 px-6` (centered, max-w-2xl content) |

**Vary the rhythm.** Don't paint the entire app with `space-y-2`. Sections deserve `space-y-4` or `space-y-6` between groups; siblings stay tight.

### 1.4 Radii

```css
--radius: 0.625rem;       /* 10px — base */
--radius-sm: 0.375rem;    /* 6px — chips, badges */
--radius-md: 0.5rem;      /* 8px — buttons, inputs */
--radius-lg: 0.75rem;     /* 12px — cards, sidebar rows */
--radius-xl: 1rem;        /* 16px — composer outer */
--radius-2xl: 1.25rem;    /* 20px — composer inner / hero card */
```

Pill/full-round (`9999px`) only for: status dots, sender avatars (none yet), the send icon button. Avoid stadium-rounded buttons (current trend cliché).

### 1.5 Elevation

Dark mode doesn't get drop shadows; it gets *seam contrast*.

| Level | Treatment |
|---|---|
| 0 (flat) | No border, no shadow — body content. |
| 1 (seam) | `border border-border` on `--surface-1`. Sidebar, header bands. |
| 2 (raised) | `border border-border-strong` on `--surface-2`, **plus** a subtle inner `bg-gradient-to-b` from `--surface-2` to `--surface-1`. Composer, hero card. |
| 3 (overlay) | `--popover` with `border border-border-strong` and `shadow-2xl shadow-black/40`. Select dropdowns, future command palette. |

No glassmorphism (PRODUCT.md anti-reference). No gradient borders.

### 1.6 Motion

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quart) | Default for any transition. |
| `--duration-quick` | `120ms` | Hover, focus, button press, color shifts. |
| `--duration-base` | `200ms` | Reveal, expand, slide. |
| `--duration-slow` | `400ms` | Page-level transitions. |
| `--pulse-live` | `2s ease-in-out infinite` | Status dot for live runs. Subtle (opacity 0.6 → 1.0). |

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` disables pulses entirely (dots become solid) and shortens transitions to `1ms`. No layout-property animation. No bounce / elastic curves.

---

## 2. Components

The catalog below documents the *target* state. Existing implementations are noted where they diverge.

### 2.1 Button

shadcn primitive at [`src/web/src/components/ui/button.tsx`](src/web/src/components/ui/button.tsx).

| Variant | Treatment | Use |
|---|---|---|
| `default` | Heat fill, dark forge-charcoal text. | Primary action: "Start", "Save", "Send". |
| `outline` | `border-border` on `--surface-1`, hover bumps to `--border-strong`. | Secondary action: "Format JSON", "Cancel". |
| `ghost` | Transparent, `text-muted-foreground`, hover fills with `--accent`. | Icon buttons in chrome (refresh, sidebar `+`). |
| `destructive` | `border-destructive/35 bg-destructive/12 text-destructive`, hover bumps. | Abort. Always paired with text label or `aria-label`. |
| `secondary` | `--surface-1` border + subtle bg. | Tertiary controls, segmented selectors. |
| `link` | Underline on hover. | Inline anchors only. |
| **Current divergence** | `heat` variant currently aliases to `primary` (which is blue). After the redesign, `--primary = --heat`, so `default` IS heat and the `heat` alias can be deleted in favor of `default`. |

Sizes: `sm` (h-8), `default` (h-9), `lg` (h-11), `xl` (h-12). Hero composer send is `lg` icon-button (rounded-full). Sidebar `+` is `sm icon`.

### 2.2 StatusPill

`src/web/src/components/status-pill.tsx`.

Status → variant → color mapping, updated:

| Status | Variant | Dot color | Pill border / fill / text |
|---|---|---|---|
| `running`, `claimed`, `preparing`, `verifying`, `fixing`, `reviewing`, `watching_ci`, `delivering`, `creating_pr` | `working` | `--copper`, pulse | `border-copper/40 bg-copper/10 text-copper` |
| `waiting_for_control` | `attention` | `--heat`, pulse | `border-heat/45 bg-heat/12 text-heat` |
| `pr_created`, `completed` | `done` | `--jade` | `border-jade/40 bg-jade/10 text-jade` |
| `failed`, `cancelled` | `failed` | `--destructive` | `border-destructive/45 bg-destructive/10 text-destructive` |
| `queued` | `queued` | `--muted-foreground` | `border-border bg-accent text-muted-foreground` |

**Important divergence from current**: today `running` uses `--steel` (blue). After redesign, working states are *copper*, freeing heat to mean "this run is waiting for *you*" — a single high-signal moment.

Always renders: `<dot> + <label>`. Reduced-motion drops the pulse but keeps the dot.

### 2.3 Composer (ControlBar)

`src/web/src/components/control-bar.tsx`.

- Outer: `rounded-2xl border border-border` with `p-px`. Focus-within bumps to `border-heat/70` plus a `shadow-[0_0_0_1px_var(--heat-glow)]` glow.
- Inner: `bg-surface-2` with `rounded-[19px]`.
- Textarea: `text-base` (15px), min-h `96px` (h-24), max-h `192px`. Placeholder uses `text-muted-foreground/55`.
- Controls row: control-kind select (Steer / Follow-up / Prompt) + runtime badge + sandboxed badge + `⌘↵` kbd + send button.
- Send button: `lg` icon, `rounded-full`, `bg-heat text-primary-foreground`. Disabled state: `opacity-40` not `opacity-70` (clearer).
- Heat glow appears only on focus-within, not by default. Don't add a permanent glow — it dilutes the live-run pulse.

### 2.4 Sidebar (ProjectRail)

`src/web/src/components/project-rail.tsx`.

- Width: `272px` (slight bump from 296 for proportions).
- Top: brand mark + wordmark; serves as `Link to /`.
- "Projects" section header: `text-caption uppercase tracking-wide`, with the `+` icon **right-aligned that links to `/`** — no more inline IntakeForm popup.
- Project group rows: `h-9`, click anywhere on the row toggles. Chevron + folder icon + name + live count badge (heat-tinted if any thread is live, muted otherwise).
- Thread rows: `h-9`, `text-sm`, `pl-7 pr-2.5`. Status dot uses the StatusPill color logic. The **active thread row** gets a 2px `--heat` left rail (channel rail; not a side-stripe-as-decorative-accent — see PRODUCT.md absolute bans) plus `bg-surface-2`.
- Footer cluster: stacked sections with clear borders between session row → config link → connection chip. Connection chip uses jade when online, heat when connecting, destructive when offline, muted when idle.

### 2.5 Home hero (new chat at `/`)

New component, recommended path `src/web/src/components/home-hero.tsx`. Replaces the current `EmptyAnvil`.

Layout:
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│              [forge mark]                            │
│              TaskSmith                               │
│              Forge tasks into reviewable PRs.        │
│                                                      │
│              ┌────────────────────────────────────┐  │
│              │ Repo ▾    Adapter ▾                │  │
│              ├────────────────────────────────────┤  │
│              │                                    │  │
│              │ Describe the change. Link a Jira   │  │
│              │ or GitHub issue. Or both.          │  │
│              │                                    │  │
│              │                                    │  │
│              ├────────────────────────────────────┤  │
│              │   Title (optional)        ⌘↵  ➜    │  │
│              └────────────────────────────────────┘  │
│                                                      │
│              Recent · pi-spike · core-hub · …        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Centered, `max-w-2xl` content column.
- Hero card: same elevation as the composer (Level 2). One unified card containing repo+adapter row, prompt textarea, title row + send.
- Recent threads strip: horizontally-scrolling pills of last 6 runs (status dot + title, ≤24ch truncate). Clicking navigates to `/runs/$id`.
- First-visit empty state (no runs at all): replace the recent strip with three quiet example prompt seeds derived from configured repos — *"Fix flaky e2e in `repoKey`"* style, but only if `repositories.length > 0`. Don't ship fake demo prompts.

### 2.6 Run view (Anvil)

`src/web/src/components/anvil.tsx`.

**Two-row header band** replacing the current cramped single-row header:

Row 1 (h-14):
- Large run title (`text-h1`, max width 60ch, truncate).
- StatusPill on the right edge.
- Refresh and Abort icon buttons.

Row 2 (h-10, lighter border-bottom):
- Repo chip + source chip (with external-link icon if URL present) + PR chip (if exists) — each on its own background tint matching role (repo: neutral; source: muted; PR: jade).
- Right edge: `shortId(run.id) · formatRelativeTime(run.updatedAt)` in mono caption.

Below header:
- Optional error band (destructive band, full-width, `text-sm`).
- Event stream, `max-w-[1024px]` centered (up from 960).
- Composer pinned bottom, same `max-w-[1024px]`.
- **Remove** the duplicate footer connection indicator — sidebar's connection chip is the single source of truth.

### 2.7 EventCard

`src/web/src/components/event-card.tsx`.

Three card families:

1. **Assistant message** — typographic, no chrome.
   - `text-base` (15px) for prose, leading 26px.
   - Bot icon + relative time in `text-caption` below.
   - No card border.

2. **User message** — right-aligned bubble.
   - `max-w-[80%]`, `rounded-2xl rounded-br-md`.
   - `bg-heat-muted border-heat/25` (subtle heat tint — the user is the operator, the operator is the heat-tone identity).
   - `text-base` body, `text-caption` meta row with control-kind label.

3. **Work events** (tool_call, tool_result, command, command_output, verification, review, delivery, ci, queue_update, session_state) — bordered card.
   - `border border-border bg-surface-1 rounded-lg px-4 py-3`.
   - Header row: role-colored icon chip + label + mono sequence (`text-mono-xs`).
   - Body: `text-mono` (13px, not the current 12px), `max-h-72 overflow-auto`.
   - Role color (icon chip background tint):
     - tool_call, command, command_output → copper
     - tool_result → jade
     - verification, review, delivery, ci → jade if status=passed/created/completed, copper if running, destructive if failed
     - queue_update, session_state → steel

4. **Error events** — destructive band, same density as work cards but with the destructive border + fill.

5. **Divider events** (`attempt_done`, others) — horizontal rule + small caption, jade if completed, destructive if failed, muted otherwise.

### 2.8 Form primitives

- `Input` ([ui/input.tsx](src/web/src/components/ui/input.tsx)) — already h-10 with text-sm; **acceptable**. Update focus ring from blue-primary to heat-primary automatically when `--primary = --heat`.
- `Textarea` — already text-[0.95rem]. Bump to `text-base` for consistency. Min-height 96px (already 120 — slightly tall but fine).
- `Select` (Radix wrapper) — content panel uses `--popover` token (will pick up new value), item hover uses `--accent`. No changes needed.

### 2.9 Login page

`src/web/src/components/login-page.tsx`. Replace the `Hammer` mark + `bg-primary/15 text-primary` block with the same forge mark used in the new sidebar header, in a heat-tinted square. Card border-strong, body copy bumped to `text-sm`. Otherwise unchanged.

### 2.10 Config page

`src/web/src/components/config-page.tsx`. Header band matches the new Anvil row-1 layout (h-14 px-6, large title). Cards inside use the new elevation rules (Level 2). The right column reference cards stay; tighten copy to `text-sm` (currently a mix of `text-xs` and `text-[11px]`).

---

## 3. Iconography

- Library: **lucide-react** (already in use). Do not mix libraries.
- Stroke width: `1.75` for primary chrome icons (default is 2 — slightly heavy). `2` for icons inside small chips (size-3 or size-3.5) where 1.75 reads as faint.
- Sizes:
  - `size-3` (12px) — in captions, badges, status dots inline.
  - `size-3.5` (14px) — buttons, sidebar rows, ghost icon buttons.
  - `size-4` (16px) — primary headers, brand icon contexts.
  - `size-5` (20px) — empty-state hero icon, login icon.
- Brand mark: keep the `Flame` lucide icon as the recognizable forge symbol. Container is `rounded-md border border-heat/40 bg-heat-muted size-8` with the flame in `--heat`.

---

## 4. Surface inventory (current → target)

| Surface | Today | Target |
|---|---|---|
| `/` empty | `EmptyAnvil` placeholder ("Pick a run from the sidebar") | Full-bleed HomeHero (composer + recent strip) |
| `/runs/$id` | Cramped one-row header, 6 pills fighting for space | Two-row header band, breathing room |
| Sidebar | Project rail with inline IntakeForm popup | Project rail with `+ → /`, no inline form |
| Composer | Functional, blue focus | Functional, **heat** focus glow |
| EventCard work | `text-[12px]` font, 10–11px headers | `text-mono` (13px) body, `text-caption` (12px) headers |
| EventCard assistant | `text-[15px]` | `text-base` (15px), tighter spacing |
| Run header connection | Two indicators (footer + sidebar) | One indicator (sidebar only) |
| Primary color | `oklch(0.59 0.2 264)` (blue) | `oklch(0.72 0.175 60)` (heat) |
| Status `running` color | `--steel` (blue) | `--copper` (working) |
| Brand mark in masthead | Component exists, not rendered | Delete `masthead.tsx`; brand mark lives in sidebar header |

---

## 5. Accessibility

Restating PRODUCT.md §Accessibility with concrete deltas:

- All foreground/background pairs above pass WCAG AA at the listed lightness values. Verify on each PR with a contrast checker; the riskier pairs are `--muted-foreground` (0.68 / chroma 0.008) on `--background` (0.135) — measured ≈4.95:1, comfortably ≥4.5.
- Status color is *always* paired with an icon and a text label. No bare colored dots without context.
- Focus-visible ring uses `--heat` at `0.45` opacity with `ring-2 ring-offset-0` so it reads on any surface.
- `prefers-reduced-motion: reduce` removes pulses, sets transition durations to `1ms`, disables horizontal recent-thread auto-scroll if added.
- Keyboard targets:
  - `/` global → focus composer.
  - `⌘↵` → submit composer (existing).
  - `⌘k` → (future) command palette. Reserved; do not bind to anything else.
  - All sidebar rows reachable via Tab in document order, no `tabIndex=-1` hiding.

---

## 6. Out of scope (explicit non-goals for this design)

- Light theme.
- Compact / dense / comfortable density toggle.
- Per-user theming.
- Marketing landing surface.
- Mobile-first layout. The shell minimum target is **1024px wide**; at <1024 we fall back to a stacked single-column with sidebar hidden behind a button. We do not aspire to a delightful mobile experience.
- New iconography or custom illustration. Lucide-only.
- Custom font self-hosting (deferred). System stack is acceptable until brand decides.

---

## 7. Where this differs from current code

Specific tokens, classes, or patterns in the codebase that need to change to land this system are enumerated in [`docs/UI-REDESIGN-BRIEF.md`](docs/UI-REDESIGN-BRIEF.md). DESIGN.md is the spec; the brief is the file-by-file implementation guide.
