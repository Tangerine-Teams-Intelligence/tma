# Component Inventory — Tangerine Meeting-Live

**Status:** Wave 3 cross-cut audit (2026-04-26)
**Spec:** `VISUAL_DESIGN_SPEC.md` v2.0
**Owner:** UI/UX

This doc inventories every React component under `app/src/components/` and `app/src/routes/` with the design tokens it relies on, dark-mode coverage, and any open visual-coherence debt. The audit is **incremental** — components flagged for rewrite are tagged so future cleanup waves can pick them up without re-discovering the work.

---

## §1 Token coverage legend

| Tag | Meaning |
|---|---|
| `tokens` | Component reaches color exclusively through `var(--ti-*)` or `bg-ti-*` utilities. No hardcoded hex / no `bg-stone-X` literals. |
| `tailwind-stone` | Component uses `bg-stone-X dark:bg-stone-Y` paired classes. Working dark-mode pattern, but not spec-canonical. Eligible for migration to `var(--ti-paper-100)` etc when next touched. |
| `safety-net` | Component uses `bg-stone-X` light-only (no `dark:` variant). Caught by `index.css` "dark mode safety net" block, but needs a real `dark:` class on the next pass. |
| `ad-hoc-hex` | Inline hex (`#B83232`, `#2D8659`, `#FFD9B8`, …). Should migrate to `var(--ti-danger)` / `var(--ti-success)` / `var(--ti-warn)` tokens added in this wave. |
| `intentional` | Hardcoded color is by-design (e.g., StickyNote 6-color picker, brand `#CC5500`). Do not migrate. |

---

## §2 Suggestion-tier components

These are the v1.9 P1-B → v2.0 surfaces that fire as "the AI noticed something". Spec §2 marks them as the visual anchor for the orange brand mark and `ti-accept-flash`.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `Banner` | `suggestions/Banner.tsx` | `tokens` | OK | Uses `var(--ti-bg-elevated)`, `var(--ti-border-default)`, `var(--ti-orange-*)`. Plays `ti-accept-flash` on accept. |
| `BannerHost` | `suggestions/BannerHost.tsx` | `tokens` | OK | Mounts above route content per `--ti-bg-elevated` lift. |
| `Modal` | `suggestions/Modal.tsx` | `tokens` | OK | `bg-black/40` backdrop in light, `bg-black/60` in dark. `animate-fade-in`. |
| `ModalHost` | `suggestions/ModalHost.tsx` | `tokens` | OK | Centered with `radius-lg` per spec §1.4. |
| `InlineReaction` | `ambient/InlineReaction.tsx` | `tokens` | OK | The `🍊` margin dot is a brand emoji per spec §6. Inline `#CC5500` style is intentional (brand mark stays unfiltered both modes). |
| `AmbientInputObserver` | `ambient/AmbientInputObserver.tsx` | n/a | n/a | Pure logic, no visual layer. |

---

## §3 Co-thinker surfaces

The "always-on collaborator" UI. Spec §3 ties `ti-pulse` here.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `HeartbeatBadge` | `co-thinker/HeartbeatBadge.tsx` | `tokens` | OK | Three-dot pulse via inline `animation: ti-pulse 1.4s ease-in-out infinite`. The canonical reference for the spec's 1.4s cadence. |
| `HomeStrip` | `co-thinker/HomeStrip.tsx` | `tailwind-stone` | OK | Uses `bg-stone-50 dark:bg-stone-900` paired classes. Inline pulse follows the 1.4s cadence. |
| `CitationLink` | `co-thinker/CitationLink.tsx` | `tokens` | OK | `text-[var(--ti-orange-700)]` on click, scrolls to sticky reasoning entry (`.ti-sticky-reasoning-flash`). |

---

## §4 Canvas

v1.7 → v1.8 sticky-note canvas. Sticky color picker is intentional 6-color UX.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `CanvasView` | `canvas/CanvasView.tsx` | `tailwind-stone` | OK | Pan/zoom container; uses `bg-stone-100` for paper feel. |
| `StickyNote` | `canvas/StickyNote.tsx` | `intentional` (6-color) | OK | Yellow / pink / blue / green / orange / purple palette is user-pickable categorical color. Spec §6 explicitly preserves the picker. Orange variant uses `var(--ti-orange-*)`. |
| `CommentThread` | `canvas/CommentThread.tsx` | `tailwind-stone` | OK | Comment row uses paired stone classes. |
| `AgiPeer` | `canvas/AgiPeer.tsx` | `tokens` | OK | AGI peer ring uses `ring-[var(--ti-orange-300)]` + inline `ti-pulse`. |
| `AgiStickyAffordances` | `canvas/AgiStickyAffordances.tsx` | `tokens` | OK | `bg-[var(--ti-orange-500,#CC5500)]` on the AGI dot — intentional brand anchor. |

---

## §5 Graphs (reactflow)

v2.0-beta.1 — four graph surfaces. Spec §4 locks node shapes + edge styles.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `WorkflowGraph` | `graphs/WorkflowGraph.tsx` | `mixed` | OK | Edge styles use `var(--ti-ink-700)`, `var(--ti-orange-500)`, `var(--ti-danger)` with hex fallbacks. Nodes `bg-stone-X dark:bg-stone-Y`. |
| `DecisionLineageTree` | `graphs/DecisionLineageTree.tsx` | `mixed` | OK | Decision diamond uses `bg-[var(--ti-orange-500,#CC5500)]`. Writeback nodes use `border-[var(--ti-success,#2D8F4E)]`. |
| `ProjectTopology` | `graphs/ProjectTopology.tsx` | `mixed` | OK | Status colors use `var(--ti-success)`, `var(--ti-warn)`, `var(--ti-danger)` tokens. Hex fallbacks for bare browsers. |
| `SocialGraph` | `graphs/SocialGraph.tsx` | `mixed` | OK | Edge stroke uses `var(--ti-ink-700)`. Person nodes use `--ti-bg-elevated` + 1px `--ti-ink-700` border per spec §4.2. |
| `graphLayout` | `graphs/graphLayout.ts` | n/a | n/a | Pure dagre wrapper, no visual layer. |

---

## §6 Layout

App-shell scaffolding.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `AppShell` | `layout/AppShell.tsx` | `tailwind-stone` | OK | Top-level `bg-stone-50 dark:bg-stone-950` flips via paired classes. Toast strip uses `animate-fade-in`. |
| `Sidebar` | `layout/Sidebar.tsx` | `tailwind-stone` | OK | Left nav. Uses paired stone classes; AI Tools section + active-agents section embedded. |
| `ActiveAgentsSection` | `layout/ActiveAgentsSection.tsx` | `tailwind-stone` | OK | Status dots use `bg-emerald-500` / `bg-amber-500` / `bg-rose-500`. Eligible to migrate to `bg-ti-success` / `bg-ti-warn` / `bg-ti-danger` (new tokens this wave). |

---

## §7 AI Tools

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `AIToolsSection` | `ai-tools/AIToolsSection.tsx` | `tailwind-stone` | OK | Tool list inside Sidebar. |
| `AIToolSetupPage` | `ai-tools/AIToolSetupPage.tsx` | `tailwind-stone` | partial | Setup form uses paired stone classes. Some error-state colors are still raw hex; eligible for `var(--ti-danger)` migration. |

---

## §8 Marketplace (v3.0)

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `TemplateCard` | `marketplace/TemplateCard.tsx` | `tailwind-stone` | OK | Hover lift via `hover:shadow-md`. |
| `TemplateDetail` | `marketplace/TemplateDetail.tsx` | `tailwind-stone` | OK | Body section + install CTA. |

---

## §9 Review (v1.9 P3)

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `ReviewPanel` | `review/ReviewPanel.tsx` | `tailwind-stone` | OK | Diff blocks use paired stone classes; accept/reject buttons use `var(--ti-orange-*)`. |

---

## §10 Top-level components (`components/*.tsx`)

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `ActivityFeed` | `ActivityFeed.tsx` | `tailwind-stone` | OK | Sidebar right-rail. |
| `AlignmentBars` | `AlignmentBars.tsx` | `tailwind-stone` | OK | Progress bars; reachable via `/alignment`. |
| `CommandPalette` | `CommandPalette.tsx` | `tailwind-stone` | OK | Modal overlay; `animate-fade-in` + `backdrop-blur-sm`. |
| `DailyBriefCard` | `DailyBriefCard.tsx` | `tailwind-stone` | OK | Card surface with paired stone classes. |
| `InviteLinkModal` | `InviteLinkModal.tsx` | `tailwind-stone` | OK | Confirms via `Modal` host. |
| `LicenseTransitionBanner` | `LicenseTransitionBanner.tsx` | `tokens` | OK | Uses `var(--ti-orange-*)` and `var(--ti-bg-elevated)`. |
| `MarkdownView` | `MarkdownView.tsx` | `mixed` | OK | Source-mode banner uses `var(--ti-orange-200)` + `var(--ti-orange-50)` fallbacks. |
| `MemoryTree` | `MemoryTree.tsx` | `tailwind-stone` | OK | Tree-indent rows. |
| `PersonView` | `PersonView.tsx` | `tailwind-stone` | OK | Person card. |
| `ProjectView` | `ProjectView.tsx` | `tailwind-stone` | OK | Project header. |
| `SyncStatusIndicator` | `SyncStatusIndicator.tsx` | `tokens` | OK | Status pill uses `var(--ti-success)` for synced, `var(--ti-warn)` for pending. |
| `TangerineNotes` | `TangerineNotes.tsx` | `tailwind-stone` | OK | Editor surface. |
| `ThreadView` | `ThreadView.tsx` | `tailwind-stone` | OK | Thread message stack. |
| `TimelineEvent` | `TimelineEvent.tsx` | `tailwind-stone` | OK | Event row in timeline. |
| `WhatsNewBanner` | `WhatsNewBanner.tsx` | `tokens` | OK | Uses `var(--ti-orange-*)` palette. |

---

## §11 UI primitives (`components/ui/`)

shadcn-derived primitives.

| Component | Path | Tokens | Dark mode | Notes |
|---|---|---|---|---|
| `Button` | `ui/button.tsx` | `tokens` | OK | Variants `primary` / `secondary` / `ghost` / `danger` / `outline`. Primary uses `var(--primary)` which aliases to `var(--ti-orange-500)`. |
| `Card` | `ui/card.tsx` | `tailwind-stone` | OK | `bg-white dark:bg-stone-900`. Eligible to migrate to `bg-[var(--ti-bg-elevated)]` per spec §2 base card. |
| `Input` | `ui/input.tsx` | `tokens` | OK | 1px `var(--border)` with focus ring `var(--ring)`. |
| `Label` | `ui/label.tsx` | `tokens` | OK | Body text. |
| `Progress` | `ui/progress.tsx` | `tokens` | OK | Bar uses `var(--ti-orange-500)`. |

---

## §12 Routes

Route components live in `app/src/routes/*.tsx`. They are thin wrappers around the components above; their own visual code is mostly layout (`mx-auto max-w-…`) and section headers. Spot-checks below — all routes render in light + dark.

| Route | Tokens | Notes |
|---|---|---|
| `today.tsx` | `tailwind-stone` | Daily brief landing. |
| `inbox.tsx` | `tailwind-stone` | Suggestion review queue. |
| `memory.tsx` | `tailwind-stone` | Memory tree explorer. |
| `canvas.tsx` | `tailwind-stone` | Hosts `CanvasView`. |
| `co-thinker.tsx` | `tailwind-stone` | Co-thinker reasoning log. |
| `alignment.tsx` | `tailwind-stone` | Alignment bars. |
| `billing.tsx` | `mixed` | Trial-countdown banner uses `var(--ti-orange-500)/30` + `var(--ti-orange-50)`. Critical-tier urgency uses `#B83232` raw hex (eligible for `var(--ti-danger)`). |
| `auth.tsx` | `mixed` | Sign-in form. Error text uses `text-[#B83232]` raw hex (eligible for `var(--ti-danger)`). |
| `marketplace/index.tsx` | `tailwind-stone` | Template grid. |
| `marketplace/[id].tsx` | `tailwind-stone` | Template detail. |
| `decisions/lineage.tsx` | `tailwind-stone` | Hosts `DecisionLineageTree`. |
| `projects/topology.tsx` | `tailwind-stone` | Hosts `ProjectTopology`. |
| `people/social.tsx` | `tailwind-stone` | Hosts `SocialGraph`. |
| `sources/*.tsx` (calendar, discord, email, github, linear, loom, notion, slack, voice-notes, zoom) | `mixed` | Each source connector uses `text-[#2D8659]` (success) and `text-[#B83232]` (error) for connection-state lines. Eligible for `var(--ti-success)` / `var(--ti-danger)` migration. |

---

## §13 Iconography

Per spec §6:

* **Primary library:** `lucide-react`. Used everywhere. No alternatives imported.
* **Brand emoji:** `🍊` is the AGI signal indicator (`InlineReaction.tsx`, sticky `is_agi` flag, decision-tier suggestions). Native emoji rendering is intentional per spec §6.
* **Source brand icons:** discord / slack / github / linear / gmail use vendor-recognizable icons via `lucide-react` matches (`MessageSquare`, `Hash`, `GitPullRequest`, etc).
* **Status dots:** 8px circles. `ti-live-dot` is the canonical pulse for "live"; static dots use `bg-ti-success` / `bg-ti-warn` / `bg-ti-danger` (Wave 3 tokens).

---

## §14 Animation timing inventory

| Class / keyframe | Duration | Easing | Spec §3 tier | Where used |
|---|---|---|---|---|
| `transition-fast` (tailwind utility, `--ti-dur-fast`) | 150ms | default | between `quick` (100ms) and `medium` (200ms) — pre-spec | Buttons, inputs |
| `duration-quick` (Wave 3) | 100ms | inherits | `fast` per spec | Hover/focus rings (new components) |
| `duration-medium` (Wave 3) | 200ms | inherits | `medium` per spec | Panel open/close, modal fade |
| `duration-slow` (Wave 3) | 400ms | inherits | `slow` per spec | Route change, graph layout settle |
| `animate-fade-in` | 200ms | ease-out | `medium` | Modal, banner, toast, observer panel, dialog |
| `animate-live-pulse` | 2s | ease-in-out | n/a (legacy LV-0 pulse) | `ti-live-dot` "live" indicator |
| `animate-ti-pulse` (Wave 3) | 1.4s | ease-in-out | spec-canonical co-thinker cadence | Heartbeat badge, AGI peer ring (now also reachable through tailwind utility) |
| `ti-accept-flash` | 200ms | ease-out forwards | `medium` | Suggestion accept (chip / banner / toast / modal CTA) |
| `ti-sticky-reasoning-flash` | 1.6s | ease-out | n/a (one-shot scroll target highlight) | `/co-thinker` sticky scroll-to |

---

## §15 Migration backlog (ordered by impact)

These are **incremental** opportunities surfaced by this audit. They are intentionally NOT done in this wave per spec ("DO NOT do massive sweeping renames — incremental, safe replacements only"). Future waves can pick them up one component at a time when those files are otherwise touched.

1. **Source connector status lines** (`routes/sources/*.tsx`, ~10 files). Replace `text-[#2D8659]` → `text-[var(--ti-success)]` and `text-[#B83232]` → `text-[var(--ti-danger)]`. Highest reach (every source route).
2. **`auth.tsx` + `billing.tsx` error states**. Replace `text-[#B83232]` and `bg-[#B83232]/5` → `var(--ti-danger)` token form. Two routes, ~6 sites.
3. **`StatePill.tsx` meeting-state palette**. Currently a 9-state hardcoded hex map (`#E7E5E4`, `#DBEAFE`, etc.). Wave 3 token set covers `success/warn/danger`; `live`/`pending`/`reviewed`/`merged` etc. don't have direct tokens. Defer until categorical-state tokens are added (likely v3.5 enterprise themes).
4. **`Card` UI primitive** to default to `bg-[var(--ti-bg-elevated)]` per spec §2 base card.
5. **`ActiveAgentsSection` status dots** to use Wave 3 `bg-ti-success` / `bg-ti-warn` / `bg-ti-danger`.

---

## §16 Out-of-band: dark-mode safety net

`index.css` carries a regression-protection block (lines 180-208) that backstops any plain `bg-stone-50/100/200` and `text-stone-900/700/500` so the entire surface flips when `<html>` carries `.dark` or `[data-theme="dark"]`. This is intentional — it lets us migrate components incrementally without breaking dark mode in the interim. It does NOT cover `bg-blue-X`, `bg-emerald-X`, `bg-rose-X` etc., so categorical color components must declare their `dark:` variant explicitly (and they do — see `StickyNote`).

The Wave 3 cross-cut (this audit) added:

* **Spec §1 semantic state tokens** — `--ti-success`, `--ti-warn`, `--ti-danger` (light + dark values).
* **Spec §3 timing tokens** — `--ti-dur-quick / medium / slow` plus `--ti-ease-in-out`.
* **Spec §3 keyframe** — `ti-fade-in` global alias (tailwind `animate-fade-in` was already shipped; this is the inline-style fallback).
* **Spec §3 + §7 reduced-motion media query** — collapses every animation to instant except `ti-pulse` (which freezes at full opacity to retain semantic meaning).
* **Spec §8 CJK line-height bump** — `:lang(zh) body { line-height: 1.57 }`.
* **Tailwind utilities** — `bg-ti-success` / `bg-ti-warn` / `bg-ti-danger`, `duration-quick/medium/slow`, `animate-ti-pulse` are now reachable from the utility layer.
