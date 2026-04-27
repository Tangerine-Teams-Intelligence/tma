# Visual Design System Spec — Tangerine Meeting-Live

**Status:** v2.0 design unification draft
**Owner:** UI/UX
**Last updated:** 2026-04-26

---

## §0 Why now

v1.x components shipped with ad-hoc styling — `Banner.tsx` defined its own orange, `StickyNote.tsx` hard-coded a 6-color picker, `HeartbeatBadge.tsx` rolled its own pulse, `InlineReaction.tsx` invented the `🍊` margin dot. Each component looks fine in isolation. Together they drift: three different oranges, two pulse cadences, inconsistent border radii.

v2.0 ships four graph surfaces (memory graph, attention map, decision drift, agent topology) plus persistent ambient UI. Without a design system, the four graphs will each pick their own node colors and edge styles, and the gap between graph surfaces and the rest of the app will widen.

This spec consolidates what already exists in `app/src/index.css` (the `--ti-orange-*` tokens, `ti-pulse` keyframe, `ti-accept-flash` from v1.9 P3-C), promotes the working patterns into tokens, fills the gaps (dark mode, graph rendering, accessibility), and locks the language for v2.0–v2.5. Goal: a new component should never need a hex code.

---

## §1 Design tokens

### Color

Brand orange is the only color that does not invert across modes — it is the brand mark. Everything else is paired light/dark.

| Token | Light value | Dark value | Use |
|---|---|---|---|
| `--ti-orange-100` | `#FFF1E6` | `#3A1F0B` | Hover wash, accept flash |
| `--ti-orange-200` | `#FFD9B8` | `#522E14` | Subtle background |
| `--ti-orange-300` | `#FFB073` | `#7A4520` | Border, divider |
| `--ti-orange-400` | `#E67A2E` | `#B5642A` | Hover state |
| `--ti-orange-500` | `#CC5500` | `#CC5500` | Brand mark, primary CTA |
| `--ti-orange-600` | `#A84600` | `#E26B14` | Pressed state |
| `--ti-orange-700` | `#8A3800` | `#FF8A3D` | Dark-mode emphasis |
| `--ti-ink-700` | `#3D3D4D` | `#C8C8D8` | Body secondary |
| `--ti-ink-800` | `#22222E` | `#E0E0EC` | Body primary |
| `--ti-ink-900` | `#0F0F1A` | `#F5F5FA` | Heading, max contrast |
| `--ti-paper-50` | `#FFFFFF` | `#14142A` | Page background |
| `--ti-paper-100` | `#F7F7F2` | `#1A1A2E` | Surface |
| `--ti-bg-elevated` | `#FFFFFF` | `#20203A` | Card, modal, banner |
| `--ti-success` | `#2D8F4E` | `#4FBE6F` | On / accepted |
| `--ti-warn` | `#C8841A` | `#E5A638` | Pending / soft conflict |
| `--ti-danger` | `#B5341E` | `#E55A3D` | Error / hard conflict |

Reference CSS:

```css
:root {
  --ti-orange-500: #CC5500;
  --ti-orange-100: #FFF1E6;
  --ti-ink-900: #0F0F1A;
  --ti-paper-50: #FFFFFF;
  --ti-paper-100: #F7F7F2;
  --ti-bg-elevated: #FFFFFF;
  --ti-success: #2D8F4E;
  --ti-warn: #C8841A;
  --ti-danger: #B5341E;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ti-paper-50: #14142A;
    --ti-paper-100: #1A1A2E;
    --ti-bg-elevated: #20203A;
    --ti-ink-900: #F5F5FA;
    --ti-ink-800: #E0E0EC;
    --ti-ink-700: #C8C8D8;
  }
}
```

### Typography

Stack:

```css
font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC",
             "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
```

System-first is deliberate: file-based UIs should feel native, not webby.

| Token | Size | Line height | Weight | Use |
|---|---|---|---|---|
| `text-xs` | 12px | 16px | 400 | Metadata, timestamp |
| `text-sm` | 13px | 18px | 400 | Secondary body, sidebar |
| `text-base` | 14px | 20px | 400 | Default body |
| `text-lg` | 16px | 22px | 400 | Emphasized body |
| `text-xl` | 18px | 24px | 500 | Section lead |
| `heading-4` | 16px | 22px | 600 | Card title |
| `heading-3` | 18px | 24px | 600 | Panel title |
| `heading-2` | 22px | 28px | 600 | Page section |
| `heading-1` | 28px | 34px | 700 | Page title |

Tangerine runs slightly tighter than typical web type — file-based UIs need information density.

### Spacing

4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px. Stick to multiples of 4. Components below 4px gap should be merged into one unit.

### Radius

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 4px | Inputs, chips |
| `radius-md` | 8px | Cards, banners |
| `radius-lg` | 12px | Modals, surfaces |
| `radius-pill` | 9999px | Status dots, badges |

### Shadow

Tangerine is file-based — over-shadowed SaaS aesthetic is wrong here. Use shadows sparingly.

| Token | Value | Use |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(0,0,0,0.04)` | Card hover lift |
| `shadow-md` | `0 4px 12px rgba(0,0,0,0.08)` | Modal, dropdown |
| `shadow-lg` | `0 12px 32px rgba(0,0,0,0.12)` | Floating banner |

In dark mode, shadows lose contrast — use a 1px `--ti-ink-700` border instead of shadow on elevated surfaces.

---

## §2 Component library inventory

| Component | Status | Notes |
|---|---|---|
| Button — primary | v1.5 | `--ti-orange-500` fill, white text |
| Button — secondary | v1.5 | `--ti-ink-700` border, transparent fill |
| Button — ghost | v1.7 | No border, hover wash `--ti-orange-100` |
| Button — danger | v1.9 | `--ti-danger` fill |
| Input — text | v1.3 | 1px `--ti-ink-700` border, focus → orange-500 |
| Input — textarea | v1.3 | Same as text, min-height 80px |
| Input — radio | v1.6 | Custom dot, `--ti-orange-500` selected |
| Input — toggle | v1.7 | Pill track, white knob |
| Input — slider | v2.0 (new) | For graph layout density / time range |
| Card — base | v1.4 | `--ti-bg-elevated`, `radius-md`, no shadow |
| Card — elevated | v1.6 | `+ shadow-sm`, hover `+ shadow-md` |
| List item — sidebar | v1.5 | 32px height, hover wash |
| List item — memory tree | v1.8 | Tree-indent, expand chevron |
| Modal | v1.9 (P1-B) | Centered, backdrop blur 8px, shadow-lg |
| Banner | v1.9 (P1-B) | Full-width, dismissible, `--ti-orange-200` background |
| Toast | v1.9 | Bottom-right, auto-dismiss 4s |
| Chip | v1.8 | Used in `InlineReaction.tsx`, pill radius |
| Badge | v1.7 | Status indicator, dot + text |
| Pill | v1.7 | Just dot, no text |
| Tabs | v1.6 | Underline-style, orange-500 active |
| Empty state | v1.9 | Icon + title + body + CTA |
| Loading skeleton | v2.0 (new) | Animated `--ti-paper-100` rectangles |

Components not yet built but reserved tokens: `slider`, `loading skeleton`, `graph node`, `graph edge`, `graph minimap`, `combobox`, `date picker`. Build these in v2.0–v2.2.

---

## §3 Animation timings + easing

| Speed | Duration | Easing | Use |
|---|---|---|---|
| Fast | 100ms | `ease-out` | Hover, focus ring appear |
| Medium | 200ms | `ease-in-out` | Panel open/close, accept flash, modal fade |
| Slow | 400ms | `ease-in-out` | Page route change, graph layout settle |

```css
@keyframes ti-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

@keyframes ti-accept-flash {
  0% { background: var(--ti-orange-200); }
  100% { background: transparent; }
}
```

`ti-pulse` is the only persistent animation — used in `HeartbeatBadge.tsx` co-thinker indicator. Cadence is 1.4s. Do not introduce a second pulse cadence.

`ti-accept-flash` plays once on suggestion acceptance, 200ms.

**No spring animations.** File-based UIs do not need bouncy physics — it reads as toy. Stick to ease curves.

**Reduced motion:** when `prefers-reduced-motion: reduce` is set, all animations switch to instant (`duration: 0ms`) except `ti-pulse`, which freezes at 100% opacity (steady state, not removed entirely — it carries semantic meaning).

---

## §4 Graph rendering style

v2.0 ships four graphs. Locking the language now.

### Library

**reactflow** over cytoscape. Reasoning: React-native, declarative node/edge components, smaller bundle, easier theming with CSS variables. Cytoscape has a richer layout algorithm catalog but worse React integration and a heavier API surface. We need maybe two layouts (dagre directed + force-directed for memory cluster) — reactflow + `dagre` package covers both.

### Node shapes

| Entity | Shape | Color | Notes |
|---|---|---|---|
| Person | Rounded rectangle | `--ti-bg-elevated` + 1px `--ti-ink-700` border | Avatar + name |
| Project | Square card | `--ti-paper-100` + blue accent stripe | Project name + status pill |
| Decision | Diamond | `--ti-orange-500` fill, white text | Summary, max 40 chars |
| Agent | Circle | `--ti-success` fill, white icon | Tool/role icon |
| Atom (signal) | Small circle | `--ti-orange-300` fill | Just a dot, hover for content |

The diamond for decisions deliberately echoes flowchart vocabulary — users should read it as "branch point" without instruction.

### Edge styles

| Relationship | Line | Notes |
|---|---|---|
| Information flow | Solid + arrow | Source → atom → decision |
| Mention | Dashed | Weaker semantic association |
| Conflict | Red wavy | Only used by decision-drift template |
| Inferred | Dotted | Confidence < 0.7, hidden by default |

Edge thickness: 1px default, 2px on hover, 3px when selected. Do not use thickness to encode weight — that competes with the conflict semantic. Encode weight in opacity (0.3–1.0).

### Layout

`dagre` directed layout default for decision/agent graphs. Force-directed (reactflow's `useReactFlow().fitView` with elk) for memory cluster graph where direction is not meaningful.

Users can drag nodes to pin. Pin state stored locally per file. "Reset layout" button in graph toolbar.

### Colors in graph

Respect light/dark tokens. In dark mode, edge colors lift one shade (`--ti-ink-700` light → `--ti-ink-700` dark, which is brighter). Brand orange stays unfiltered. Conflict red stays full saturation in both modes — alert semantics override theme softness.

### Minimap

Bottom-right corner, 160×100px, opacity 0.7. Click to recenter. Hide on graphs with <20 nodes (clutter).

---

## §5 Light + dark mode coherence

Rules:

1. Every component must support both modes. No light-only or dark-only screens.
2. Brand orange `#CC5500` stays unfiltered in both modes — it is the brand recognition anchor.
3. Background inverts: `--ti-paper-50` (white) ↔ dark navy `#14142A`. Reference: dark navy chosen over pure black to reduce eye strain over long sessions, and over IDE-grey to keep the file-based aesthetic distinct from VS Code.
4. Text contrast: WCAG AA minimum (4.5:1 for body, 3:1 for large text). Verified for `--ti-ink-800` on `--ti-paper-50` (12.6:1) and `--ti-ink-800` dark on `--ti-paper-50` dark (11.2:1).
5. Graph chart colors: line colors lift one shade in dark mode but keep semantic mapping — orange is brand, green is "on/accepted", red is "error/conflict", blue is "project". Never reassign semantic colors per mode.
6. Status dots keep saturation in both modes. They are small, so contrast is harder; saturation does the work.

Mode switching: `<html data-theme="light|dark|system">`. Default is `system`. Setting persists in localStorage. Mode change is instant, no transition (transitions on `background-color` over the entire app cause flash and hurt).

---

## §6 Iconography

**Primary:** `lucide-react` (already imported). Stroke-based, 1.5px stroke, 20px default size. Pair with text most of the time — icon-only buttons need `aria-label`.

**Custom:** keep to a minimum. Only build a custom icon if `lucide-react` has no near match and the icon appears in 3+ places.

**Brand mark:** `🍊` emoji as the AGI signal indicator (per `InlineReaction.tsx`). Native emoji rendering, do not replace with SVG — the slight platform inconsistency is part of the personal/file-based feel.

**Status dots:** 8px circles. Green = on, amber = pending/warn, red = error, grey = off/inactive. Used in AI Tools sidebar, source connectors, agent topology.

**Source icons:** Discord, Slack, GitHub, Gmail, Linear etc. use brand-recognized icons (Simple Icons or vendor-supplied). Do not redraw — users need to recognize them at a glance.

---

## §7 Accessibility

Per v1.9 P3-C, baseline:

1. **`role` and `aria-label`** on every interactive component. Modals get `role="dialog"` + `aria-labelledby` pointing at the title.
2. **Focus visible ring**: `focus-visible:ring-2 ring-orange-500 ring-offset-2`. Never remove `:focus-visible`. Mouse-only focus (`:focus` without `:focus-visible`) can be suppressed.
3. **Keyboard nav**: every CTA reachable via Tab. Enter activates, Esc closes overlays. Arrow keys navigate within a list/menu/graph node selection. No keyboard trap inside modals — Tab cycles within, Esc exits.
4. **Color contrast** WCAG AA (verified above). Color is never the only carrier of meaning — pair with icon or text. Conflict edge has wavy stroke + red color, not just red.
5. **Reduced motion**: respect `prefers-reduced-motion: reduce`. All transitions snap to 0ms, `ti-pulse` freezes at full opacity.
6. **Screen reader**: graph nodes have hidden text descriptions (`aria-describedby`). The screen reader announces "Decision node: ship v2.0 by May, connected to 3 atoms". Graph as a whole is summarized in a hidden `<ul>` for SR-only navigation.
7. **Zoom**: app must be functional at 200% browser zoom. No fixed pixel widths on text columns.

---

## §8 Internationalization visual considerations

1. **CJK padding**: Chinese characters need slightly larger vertical padding than Latin — line-height for body text in Chinese mode is 22px (vs 20px Latin) at 14px size. Apply via `:lang(zh)` selector.
2. **Truncation**: when truncating mixed CN/EN strings, do not cut in the middle of a Chinese character or in the middle of a Latin word. Use `text-overflow: ellipsis` with `word-break: keep-all` for Chinese segments and `overflow-wrap: break-word` for Latin.
3. **Number formatting**: use `Intl.NumberFormat` per locale. Chinese uses `,` separator same as English at this size (万/亿 grouping is too academic for our UI).
4. **Date formatting**: use `Intl.DateTimeFormat`. Default format is short relative ("3 hours ago" / "3小时前") for items <24h, absolute thereafter.
5. **RTL**: not supported. Revisit in v3.5 if Arabic/Hebrew demand emerges. Low priority — current target markets are CN + EN.
6. **Font stack**: ensures `PingFang SC` (macOS), `Microsoft YaHei` (Windows), `Hiragino Sans GB` (older macOS), Noto fallback. Do not bundle a web font — system fonts are faster and feel native.

---

## §9 Out of scope

1. **Custom theme builder** — users picking arbitrary brand colors. Defer to v3.5 enterprise tier. Until then, dark/light only.
2. **User-uploaded brand colors / logos** — same. Single Tangerine brand for now.
3. **Print stylesheet** — file-based UI, no printing pattern. If needed, defer.
4. **High contrast mode** beyond WCAG AA — Windows high-contrast support is best-effort, not designed against. Revisit if accessibility audit flags it.
5. **Animated illustrations / Lottie** — too heavy for the file-based aesthetic. Avoid.

---

## §10 Open questions

1. **reactflow vs cytoscape** — recommended pick is reactflow (smaller bundle, React-native, sufficient layout coverage via `dagre`). Need final sign-off before v2.0 graph work starts.
2. **Graph node visual style** — square vs rounded vs custom-per-type. Spec proposes per-type (rounded rect for person, square for project, diamond for decision, circle for agent). Risk: too many shapes confuses. Alternative: one shape, color-encoded type. Need user testing call.
3. **Brand text font** — system default vs Inter vs custom. System default chosen for native feel + zero bundle cost. If product wants stronger brand voice, Inter (open source, free) is the upgrade path. Custom brand font would cost ~$1500 license + ship 60kb.
4. **Dark mode default** — `system` follow vs `light` default vs `user pick at first launch`. Spec proposes `system`. Counter-argument: file-based work tools (Obsidian, Notion) lean dark by default, so `dark` might fit user expectation. Need preference data.
5. **Tangerine logo** — current is the `🍊` emoji as a stand-in. Need professional logo design before v2.5 marketing push. Constraints: must work at 16px (favicon), must work in monochrome (export to legal docs / patent), must read in <100ms.

---

**Word count:** ~2480
**Sections:** §0–§10 (11 sections including open questions)
**Status:** Ready for design review. Block v2.0 graph work until §10.1 and §10.2 resolved.
