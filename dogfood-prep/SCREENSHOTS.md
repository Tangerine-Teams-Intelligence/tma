# Tangerine AI Teams v1.12 — Screenshot Capture Plan

**Wave 25 deliverable.** 12 polish screenshots for landing page + Twitter
launch + README v1.12 hero band.

## Goal

A first-time visitor browsing the landing page or scrolling Twitter should see
Tangerine in 12 frames and grok the surface coverage without watching the video.
Each shot does one job — no marketing crowding, no fake data.

## Tools

* **Windows** — Snipping Tool (Win+Shift+S) for region capture, ShareX for
  named-output workflow
* **macOS** — Cmd+Shift+4 for region, Cmd+Shift+5 for window
* **Linux** — `gnome-screenshot -wb` for window with border
* **Annotation** — Skitch / CleanShot X for arrow + text overlays (optional;
  the landing page handles its own hero captions)

## Output dir

`dogfood-prep/video/screenshots/` (separate from the existing
`_dogfood_screenshots/` which holds tester-submitted photos from the
v1.9.1 dogfood pass).

## Format

* PNG, lossless, 2× retina (resize down on landing page side)
* Crop to actual app window — no Windows taskbar / macOS dock
* No pointer cursors visible (drop them with CleanShot's "hide cursor" option)
* Light theme for hero shots (better print contrast); dark theme for Twitter

## Naming convention

`v112-NN-<feature>.png` — NN matches the list below in order.

---

## Shot list (12 total)

### 01. /today dashboard
**File**: `v112-01-today-dashboard.png`
**Route**: `/today`
**State**: DemoModeBanner visible at top, hero search bar empty, dashboard
cards laid out (Daily Brief, Activity Feed, Workflow Graph, Recent Atoms).
**Hero use**: yes — landing page hero #1
**Twitter caption**: "Every team meeting. Every Cursor / Claude / ChatGPT
session. One dashboard."

### 02. /memory tree + preview
**File**: `v112-02-memory-tree-preview.png`
**Route**: `/memory`
**State**: File tree expanded on left (team/, personal/, with ~10 atoms
visible), preview panel on right showing one atom rendered with frontmatter.
**Hero use**: yes — landing page hero #2

### 03. /memory graph view
**File**: `v112-03-memory-graph.png`
**Route**: `/memory` with graph toggle on (Wave 23)
**State**: Force-directed graph with ~30 nodes, edges colour-coded by source
(Cursor / Claude Code / Discord / GitHub).
**Hero use**: yes — landing page hero #3
**Note**: depends on Wave 23 graph view shipping. If not ready at capture time,
substitute the existing `BrainVizHero` component as a stand-in.

### 04. /brain split editor
**File**: `v112-04-brain-split-editor.png`
**Route**: `/brain`
**State**: Split view, rendered markdown on left (~500 chars of co-thinker
output), editor on right with cursor placed, "TEAM CONTEXT: shipping v1.12
this week" line visible.

### 05. WelcomeOverlay card 1
**File**: `v112-05-welcome-card-1.png`
**Route**: any (overlay covers)
**State**: Card 1 — "No new AI subscription". Show the full card centered.
Backdrop blurred.

### 06. SetupWizard chat (Wave 18)
**File**: `v112-06-setup-chat.png`
**Route**: `/today` with OnboardingChat inline
**State**: Chat shows 2-3 messages exchanged, last user input "I use Claude
Code, link github.com/myorg/myrepo", wizard typing indicator below.

### 07. DemoModeBanner
**File**: `v112-07-demo-banner.png`
**Route**: any (banner is global)
**State**: Banner visible at top with "Browsing sample data" copy +
"Hide demo data" link.

### 08. Cmd+K palette
**File**: `v112-08-cmdk-palette.png`
**Route**: `/today` with palette open
**State**: Palette modal centered, ~5 results visible for query "auth",
result types annotated (route / atom / setting).

### 09. Settings General
**File**: `v112-09-settings-general.png`
**Route**: `/settings`
**State**: General tab, current user + memory dir + theme + language
visible; trial expiry banner showing "27 days remaining" (test data).

### 10. /canvas
**File**: `v112-10-canvas.png`
**Route**: `/canvas`
**State**: Empty board with one sticky note + one workflow-step card; the
toolbar at top with "+ Sticky" / "+ Step" buttons highlighted.

### 11. Activity feed widget
**File**: `v112-11-activity-feed.png`
**Route**: `/today` (activity is embedded in dashboard now per Wave 19/20)
**State**: Activity feed card, ~8 entries from last 24h, vendor icons
visible (Cursor, Claude Code, Discord), timestamp column on right.

### 12. Brain status widget
**File**: `v112-12-brain-status.png`
**Route**: `/today` (or `/co-thinker`)
**State**: Brain status card showing "Last heartbeat: 4 min ago" + token
counter ("~12K tokens this hour") + AGI proposal count chip ("3 active").

---

## Capture flow (do all 12 in one session)

1. Wipe install + brain (same pre-flight as VIDEO_SCRIPT.md)
2. Reinstall fresh, run through SetupWizard chat to seed config
3. Wait for first co-thinker heartbeat to land (sample data + co-thinker.md)
4. Set window size to 1440×900 (landing page hero crop ratio)
5. Light theme on
6. Walk through routes 01 → 12 in order
7. Save each shot with the named filename above
8. Rinse + dark theme on for Twitter variants (suffix `-dark.png`)
9. Drop full set in `dogfood-prep/video/screenshots/`

## Sanity check before publishing

- [ ] No real user data in any frame (use seed data only)
- [ ] No filenames in tree containing CEO's real repo names (sanitize)
- [ ] No browser tabs / Slack notifications visible
- [ ] App version chip in lower-left says "v1.12.0" (not v1.11.x)
- [ ] License banner is the new "AGPL + Commercial" copy
- [ ] No copywriting typos (especially in WelcomeOverlay cards)

## Landing page integration

The 3 hero shots (01, 02, 03) feed into the landing page hero band at
`apps/Tangerine-intelligence-Official-Site/sites/deck/`. Other 9 land
in the feature-grid sections. README v1.12 polish embeds 5 of them
inline (see README.md edits).

## Twitter launch

Pin a tweet with the 60s GIF (from VIDEO_SCRIPT.md) + thread of 4
screenshots (01 / 03 / 04 / 06 — most distinctive). Caption each with
a single sentence of the differentiator from the WelcomeOverlay copy.
