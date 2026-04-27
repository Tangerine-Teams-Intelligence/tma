# UX_FLOW_SPEC — End-to-End User Journey

> Tangerine v2.0 era unified UX flow spec. Today the app has 17 routes and 7+ component layers, each designed in isolation. After v2.0 lands graphs + AGI strip + personal vault + 5 personas, route-by-route design produces navigation chaos. This doc maps the journeys end-to-end so design decisions stop fighting each other.

## §0 Why this matters

v1.8 built 9 routes. v1.9 added 4 ambient surfaces (chip / banner / toast / modal). v2.0 adds graph home + AGI strip + personal vault + ACTIVE AGENTS sidebar + 4 graph tabs. By v2.5 there will be ~15 distinct UX surfaces. Each one was designed by the engineer who shipped that PR. None of them were designed against the question "what does Sarah, the non-technical PM, see at hour 36 of using this product?"

The cost of skipping this exercise:

1. **Onboarding regression**: every new feature inserts itself into the first-launch flow. By v2.0 a new user faces graph + sidebar + sources + agents + sensitivity slider on launch day. v2.5 adds compliance dashboard + marketplace. By v3.0 first launch becomes a 17-screen wizard.
2. **Empty state debt**: 9 routes × 4 personas = 36 empty-state combinations. Today maybe 6 are designed.
3. **Inline AGI inconsistency**: chip on `/today`, banner on `/co-thinker`, toast on `/canvas`, modal on `/sources` — what's the rule? v1.9 §3 says one but ship-time enforcement is missing.
4. **Cross-route navigation**: today the only way from `/today` to `/co-thinker` is sidebar. By v2.0 the AGI strip is the second path. Cmd+K is the third (planned). Three navigation systems competing for the same intent — pick one primary.
5. **Churn signal blindness**: the product has zero re-engagement design. A user who quits at day 7 quits silently.

This spec defines the journey before the next 5 features land. Targets: ~4000 words, builder-direct, no marketing.

---

## §1 Five Personas

### 1.1 Persona table

| Persona | Age / role | Time-to-decision | Primary goal | Primary pain | Tangerine pull |
|---|---|---|---|---|---|
| **Curious dev** | 22-30, IC engineer | 2 min | "Is this another Cursor wrapper or actually new?" | Tool fatigue — every week a new "AI productivity" app | OSS code on GitHub, 10-min self-host |
| **Team founder** | 25-35, founding eng / CEO | 30 min | "Can my 4-person team align without losing 8h/week to standups?" | Slack chaos, decision drift, no canonical "what did we decide" | Brain doc + co-thinker keeps team in sync |
| **Power AI user** | 25-40, Cursor/Claude Code daily user | 10 min | "I have 6 AI tools open — give me one place to see what they all did" | No memory across tools; same context re-typed 30×/day | MCP server + active agents feed |
| **Enterprise admin** | 30-45, IT/Sec | 60 min eval, 4-week procurement | "Does this pass our SOC 2 and SSO requirements?" | New shadow-IT every week; can't audit AI tool sprawl | SOC 2 Type II, SSO, audit log, region routing |
| **Non-technical PM** | 25-40, project / product manager | 5 min | "My eng team uses Tangerine — show me the dashboard, don't make me set up anything" | Doesn't want to install / configure; wants visibility into team work | Read-only join via team link, browser-ext fallback |

### 1.2 Why these five

These five cover the demand surface for v1.8 → v3.5:

- **Curious dev** is the OSS funnel top — every README pull starts here.
- **Team founder** is the Layer 2 conversion target (BUSINESS_MODEL §2.2). They convert OSS adoption into $5/team/month inference credits.
- **Power AI user** is the v2.0 anchor — the personal vault + ACTIVE AGENTS feed exists for them.
- **Enterprise admin** unlocks Layer 4 ($25k-100k licenses). v3.5 trigger gated on 2-3 of these in the funnel.
- **Non-technical PM** is the silent multiplier. A team's PM seeing the brain doc dashboard → that team won't churn.

The personas explicitly *not* covered: hobbyist tinkerer (overlap with Curious dev), C-suite executive (overlap with Enterprise admin), academic researcher (Layer 5 territory, post-PMF only).

### 1.3 Primary route per persona

```
Curious dev      →  /home (graph) → /memory → /co-thinker
Team founder     →  /home → /sources → invite link → /co-thinker
Power AI user    →  /home → ACTIVE AGENTS sidebar → /memory/personal/
Enterprise admin →  Settings/General → Settings/Team → audit-log route (v3.5)
Non-tech PM      →  /home (read-only) → /co-thinker → /this-week
```

---

## §2 Journey map per persona

### 2.1 Stages defined

Every persona traverses 7 stages. Most never reach all 7.

```
Discover → Install → Onboarding → Daily use → Power features → Enterprise admin → Churn / re-engage
```

### 2.2 Curious dev journey

| Stage | Action | Surface | Time | Drop-off risk |
|---|---|---|---|---|
| Discover | sees HN/Twitter post | landing site | 30s | very high — bounce in 10s if hero unclear |
| Install | clones repo OR runs `npx tangerine-mcp` | terminal | 2 min | high — abandons if `pnpm install` fails |
| Onboarding | "Solo" path → memory dir picked → no sources | first-launch wizard | 3 min | medium — abandons if asked to wire 5 sources before seeing value |
| Daily use | opens app, sees graph populate from a couple GitHub commits | `/home` | day 2-3 | high — bounces if graph empty |
| Power features | wires Cursor capture, sees personal vault fill | `/memory/personal/cursor/` | week 2 | low |
| Enterprise admin | n/a | n/a | n/a | — |
| Churn | uninstalls if no team to share with | n/a | week 4 | this is the funnel — most curious devs become team founders or churn |

Decision: design `/home` graph to render meaningfully from a fresh Cursor capture alone (1 source, < 10 atoms). Empty state is the killer for this persona.

### 2.3 Team founder journey

| Stage | Action | Surface | Time | Drop-off risk |
|---|---|---|---|---|
| Discover | recommendation from curious-dev teammate | inside the team | n/a | low |
| Install | downloads installer (Win/Mac/Linux) | OS-level | 5 min | medium — installer signing matters here |
| Onboarding | "Team" path → GitHub OAuth → create team repo → invite link | wizard step 2 | 15 min | high — drops if OAuth fails or invite UX confusing |
| Daily use | morning brief, captures standup, shares decisions | `/home` + `/co-thinker` + `/today` | daily | low if onboarding clean |
| Power features | tunes sensitivity, prunes dismissed, adopts marketplace template | Settings + `/co-thinker` | month 2 | low |
| Enterprise admin | n/a until team grows >25 | n/a | — | — |
| Churn | quits if team adoption < 3/4 members or ROI unclear | — | month 3 | high — needs explicit re-engagement |

This is the primary Layer 2 conversion path. Onboarding step 2 is the make-or-break; v2.0 spec §6 calls for "Solo default + skip-to-home" but Team path needs equal polish.

### 2.4 Power AI user journey

| Stage | Action | Surface | Time | Drop-off risk |
|---|---|---|---|---|
| Discover | sees the "10 AI tools sidebar" demo screenshot | landing site or PH | 1 min | low |
| Install | runs installer, expects it to detect Cursor | OS | 3 min | medium |
| Onboarding | skips Solo wizard, navigates straight to ACTIVE AGENTS sidebar | `/home` | 30s | low |
| Daily use | personal vault auto-fills as Cursor sessions complete | `/memory/personal/` | continuous | low |
| Power features | promote chip → push session to team; co-thinker brain edits | `/co-thinker` | week 2 | very low |
| Enterprise admin | n/a | — | — | — |
| Churn | quits if Cursor capture format breaks (V2.0 risk #3) | — | unpredictable | medium |

Critical: when this persona installs, they expect zero-config Cursor detection. v2.0 spec defaults to auto-capture from `~/.cursor/conversations/*.json` — keep this. Don't gate on opt-in.

### 2.5 Enterprise admin journey

| Stage | Action | Surface | Time | Drop-off risk |
|---|---|---|---|---|
| Discover | inbound from team founder asking for procurement approval | email / Slack DM | n/a | n/a |
| Install | requests SOC 2 docs + tries hosted demo | sales contact form | 1 day | low |
| Onboarding | hosted demo → SSO setup → audit log review | dashboard route (v3.5) | 60 min | medium |
| Daily use | rarely opens app; receives weekly audit summary | email digest | weekly | low |
| Power features | configures region routing, custom retention, custom branding | enterprise admin panel (v3.5) | month 2-3 | low |
| Enterprise admin | this IS their daily use | — | — | — |
| Churn | doesn't renew if SOC 2 audit findings unresolved | — | year 2 | medium |

Enterprise journey is mostly **outside** the desktop app. Sales conversation + compliance review + admin-only routes. v3.5 unlocks this; before then, this persona sees a "Contact sales" link and bounces.

### 2.6 Non-technical PM journey

| Stage | Action | Surface | Time | Drop-off risk |
|---|---|---|---|---|
| Discover | team founder shares invite link | email / Slack | 30s | low |
| Install | clicks link → opens browser-ext OR installs app | landing or browser | 5 min | high — must not require terminal |
| Onboarding | join-team flow → reads team brain doc | `/join-team` → `/co-thinker` | 5 min | medium |
| Daily use | morning glance at graph + brain doc; no setup | `/home` (read-only) | daily | low |
| Power features | rarely engages | — | — | — |
| Enterprise admin | n/a | — | — | — |
| Churn | quits if team founder churns (downstream); rarely independently | — | — | low |

Critical for this persona: `/join-team` route + read-only mode + zero technical setup. Browser extension as the fallback when desktop install isn't viable.

---

## §3 Onboarding flow detailed

### 3.1 First-launch screen

When the desktop app launches with no `~/.tangerine-memory/` directory, show:

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│           Tangerine — your team's AI memory.                 │
│                                                              │
│          Three paths. All open source. Pick one.             │
│                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────────────┐      │
│   │   Solo   │    │   Team   │    │   Enterprise     │      │
│   │  3 clicks│    │ 5 min    │    │  Contact sales   │      │
│   └──────────┘    └──────────┘    └──────────────────┘      │
│                                                              │
│       Already part of a team? [paste invite link]            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Tagline matters. "Your team's AI memory" — concrete, not abstract. Not "AGI co-thinker" (jargon). Not "AI-native team OS" (we say this in deep deck, not at first launch).

### 3.2 Solo path (3 clicks to live)

```
Step 1: pick memory dir       → default ~/.tangerine-memory  → [next]
Step 2: connect first source  → 4 quick options (skip allowed) → [next]
Step 3: done                  → land on /home graph (empty)   → [done]
```

Skip-to-home should be **the default emphasis**. The "skip" link must be larger than the "Connect Discord" button — a curious dev who can't connect immediately should still see the home view.

### 3.3 Team path (5 min)

```
Step 1: pick memory dir
Step 2: GitHub OAuth → ask permission for new private repo
Step 3: create or pick team repo → tangerine-team-memory
Step 4: invite link → copy to clipboard
Step 5: optional Discord/Slack source connect → skip allowed
Step 6: done → land on /home + invite confirmation modal
```

Decision: GitHub OAuth must happen step 2 not step 5 — invite link only meaningful with team repo created. Skip Discord/Slack — they can be added from `/sources` later. Don't build a 5-source-required wall.

### 3.4 Enterprise path

Today (v1.8): "Contact sales" mailto. v3.5: lands on `/enterprise-trial` route which collects company / SSO provider / region requirement and queues a sales follow-up.

Pre-v3.5 do NOT build an enterprise self-serve. The risk is shipping an SSO flow that isn't SOC 2 compliant, and the lookalike risk for an enterprise admin (they think they bought enterprise but got hobbyist) destroys deals.

### 3.5 Telemetry events

Every onboarding step fires a v1.9 telemetry event so we can build the conversion funnel. Emitted to local JSONL only — cloud sync stays opt-in (v1.9 §2.3).

| event | fields | tracks |
|---|---|---|
| `onboarding_start` | `path: solo \| team \| enterprise`, `ts` | top of funnel |
| `onboarding_step` | `path`, `step: 1-6`, `ts` | drop-off at each step |
| `onboarding_complete` | `path`, `total_ms`, `ts` | bottom of funnel |
| `onboarding_skip` | `path`, `at_step`, `ts` | optional-step abandon |

Acceptance: solo onboarding under 90s p50, team under 5 min p50, enterprise contact link clicked = success (no sales-flow tracking in app).

---

## §4 Empty states

### 4.1 The empty-state matrix

Every route has an empty state. Today most are "no data yet" with no CTA. Below is the v2.0 target.

| Route | Empty state | CTA | Onboarding hint |
|---|---|---|---|
| `/home` (graph) | no atoms, no sources | "Connect a source" + 4 source tiles | "Tangerine builds the graph from your team's data — the more you connect, the more it sees." |
| `/today` | no atoms produced today | "It's quiet today. Want to start a meeting?" | hint about Loom/Zoom autocapture |
| `/this-week` | no atoms produced this week | shows last week as fallback | — |
| `/memory` | empty tree | "Your memory tree fills in as you connect sources." | link to `/sources` |
| `/co-thinker` | brain not initialized | "Co-thinker watches your team data. Connect at least one source for it to start writing the brain doc." | link to `/sources` |
| `/canvas` | no projects | "Canvas is for free-form notes pinned to atoms. Create your first." | "+ New project" button |
| `/sources` | no source configured | "Tangerine connects to 10 sources. Pick the one your team uses most." | grid of 10 source tiles |
| `/threads` | no threads | "Threads come from Discord/Slack. Connect a chat source first." | link to `/sources` |
| `/inbox` | no items | "Tangerine surfaces unresolved decisions and stale RFCs here." | — |
| `/people` | no people | "People appear as your team mentions them." | — |
| `/projects` | no projects | "Tangerine detects projects from `projects/` in your memory." | — |
| `/alignment` | no AI tools wired | "Tangerine aligns with the AI tools your team uses (Cursor, Claude, Codex...). Wire your first." | grid of 10 AI tool tiles |
| `/ai-tools` | none configured | (same as alignment) | — |

### 4.2 Empty state design rules

1. **Always have a CTA**. Never leave a user staring at "No data". Either give them an action or explain why the data will arrive.
2. **One primary CTA, max one secondary**. Decision fatigue kills empty-state retention.
3. **No "Loading..." in empty state.** If we're still fetching, show the loading spinner. If the fetch completed and returned zero, that's the empty state.
4. **Empty state is the feature**. A new user who sees `/home` with the graph empty AND a clear "Connect Discord" tile is more likely to convert than one who lands on a populated graph but doesn't understand what they're looking at.

---

## §5 Inline AGI surface consistency

### 5.1 The four tiers (locked, v1.9)

| Tier | When it fires | Lifetime | Mute |
|---|---|---|---|
| **Chip** (280px portal, 🍊 dot) | inline contextual hint, on input | dismiss / Esc / unmount | per-channel |
| **Banner** (48px top of route) | cross-route awareness, condition-bound | until dismiss or condition resolves | per-template |
| **Toast** (bottom-right, 4s) | one-shot completion notice | auto-dismiss | per-template |
| **Modal** (blocking) | irreversible-action confirm only | blocking until acknowledged | master switch only |

### 5.2 Tier × Route enforcement matrix

| Route | Chip OK | Banner OK | Toast OK | Modal OK |
|---|---|---|---|---|
| `/home` | yes (search box) | yes (cross-route) | yes | rare |
| `/today` | yes (atom edit input) | yes | yes | no |
| `/memory` | yes (tree node edit) | yes | yes | no |
| `/co-thinker` | no (brain doc IS the surface) | yes | yes | yes (auto-merge conflict) |
| `/canvas` | yes (canvas note input) | yes | yes | no |
| `/sources` | no | yes (source health) | yes | yes (revoke OAuth confirm) |
| `/settings` | no | no | yes | yes (irreversible reset) |

Rule: **each route has at most one banner slot** (top of content area). Each route has at most one chip per input element. Toasts stack max 3, suggestion-toasts max 1. Modal global max 1 per session.

### 5.3 Tone

Every AGI surface follows v1.9 §1 disciplines + tone rules:

1. **Explain before suggesting.** "Pricing decision drift detected — last 4 atoms show $20/seat (4/22) and Vercel-style (4/26). Lock?" — explanation first, action second.
2. **Never demand.** Action verbs are offers ("Lock?" "Resolve?" "Bump?"), never imperatives.
3. **No exclamation points.** Builder voice. Concise.
4. **No emojis except the 🍊 brand mark.** Brand mark anchors the surface; everything else is text.
5. **Confidence stays hidden.** v1.9 §10 Q4 — show the user the inference, not the number.

### 5.4 Failure mode

If a tier-engine bug fires duplicate suggestions: log to telemetry, dedupe by topic_key, show only one. If two tiers want the same slot: highest tier wins (modal > toast > banner > chip).

---

## §6 Cross-route navigation patterns

### 6.1 Three navigation systems, ranked

1. **Sidebar (primary)** — persistent left rail, always visible. Routes grouped: HOME / WORK / TEAM / TOOLS / SETTINGS. ACTIVE AGENTS section between WORK and TEAM (v2.0).
2. **Cmd+K palette (secondary, planned)** — global search + nav for power users. Behavior: open with Cmd/Ctrl-K, fuzzy-search routes + atoms + people. Click result → navigate. Esc closes.
3. **Breadcrumb (tertiary)** — appears only on detail pages (`/source-detail/:id`, `/sink-detail/:id`, `/people/:id`). Top-left of route content, format `Sources > Discord > #engineering`.

### 6.2 Sidebar grouping (v2.0)

```
HOME
  Home (graph)
  Today
  This week

WORK
  Memory
  Canvas
  Co-thinker
  Inbox

ACTIVE AGENTS (3)              ← v2.0 new section
  ● Cursor — daizhe
  ● Claude Code — hongyu
  ○ Devin — team

TEAM
  People
  Projects
  Threads

TOOLS
  Sources
  AI Tools
  Alignment

ADVANCED
  Settings
```

### 6.3 Cmd+K palette behavior

Already a stub at `app/src/components/CommandPalette.tsx`. v2.0 lifts to first-class:

- Open: Cmd-K / Ctrl-K from any route
- Default view: recent routes + recent atoms
- Type: filters by name + content (fuzzy match)
- Result types: route, atom, person, project, AI tool
- Click result → navigate
- Special commands: `/connect`, `/invite`, `/sensitivity`, `/sources` jump to flows

### 6.4 Back button behavior

Browser-back maps to route history. Sidebar nav adds to history (so back returns to previous sidebar item). Cmd+K nav does NOT add to history (it's search, not navigation) — debate this in §10.

### 6.5 Deep links

All routes deep-linkable. Examples:

```
/people/daizhe         → Daizhe person view
/projects/iFactory     → iFactory project view
/source-detail/discord-eng → Discord #engineering source view
/co-thinker?tab=proposals  → co-thinker with proposals tab open
/sources?connect=slack     → sources with Slack connect modal pre-opened
```

---

## §7 Notification + system tray flow

### 7.1 System tray icon states

| State | Icon | Trigger |
|---|---|---|
| Idle | 🍊 outline (no fill) | app running, no active proposals |
| Active proposals | 🍊 filled, ink-700 | ≥ 1 proposal queued in `propose_lock.rs` |
| Error | 🍊 with red dot | source connection error, telemetry write fail, etc. |
| Paused | 🍊 outline + slash | `agiParticipation === false` |

Click tray → opens main app window if minimized, brings to front if open. Right-click → context menu: "Show", "Pause AGI", "Quit".

### 7.2 OS-level notifications

Default: high-priority only. Specifically:

- `deadline_approaching` template (toast tier in app + OS notification if app not focused)
- `conflict_detection` template (banner in app + OS notification if confidence ≥ 0.95)
- Source connection error (always notify — this is data loss)

Default OFF for: pattern_recurrence, decision_latent, long_thread, catchup_hint. User can opt-in per-template in Settings → Notifications.

### 7.3 Activity feed slide-in (already shipped v1.6+)

Right-side slide-in panel showing real-time activity. Toggled by clicking 🍊 in top-right. Shows: source events, AGI observations, suggestion fires, telemetry events.

```
ACTIVITY (live)
─────────────────
3:42  source.discord  3 new msgs in #eng
3:41  agi.observation  noticed pricing drift
3:40  suggestion.banner_shown  decision_drift
3:38  source.github  PR #284 merged
```

This is the "what just happened" surface. Power users keep it open. Casual users dismiss after first glance.

---

## §8 Settings UX flow

### 8.1 Tab structure (current → target)

| v1.8 (current) | v2.0 target |
|---|---|
| General | General |
| AI tools | AI Tools |
| Team | Team |
| Adapters | (folded into Sources) |
| Advanced | Advanced |

5 tabs → 4 tabs. AGI controls live in **General** as a single section, not a separate tab.

### 8.2 The two-knob simplification (v2.0)

Per V2_0_SPEC §5, simplify 8 user-visible AGI controls down to 2:

```
┌──────────────────────────────────────────────────────────┐
│  AGI Participation                                       │
│  [●━━━━━━━━━━━━━━━━━━] ON                                │
│                                                          │
│  Sensitivity       quiet  ┃━━━━●━━━━━┃  loud             │
│                            (50)                          │
│                                                          │
│  ▸ Advanced (per-channel mutes, confidence floor, ...) │
└──────────────────────────────────────────────────────────┘
```

- **Knob 1**: master toggle (`agiParticipation`)
- **Knob 2**: 0–100 sensitivity slider (maps to volume + confidence floor internally)
- **Advanced disclosure**: per-channel mutes, custom confidence threshold, dismiss memory, snooze, sample seed banner, what's-new — all hidden unless user clicks ▸

### 8.3 Reset to defaults

Each settings tab gets a "Reset this tab to defaults" link at the bottom. Plus a global "Reset all settings" in Advanced (with confirm modal — irreversible).

### 8.4 Settings flow events (telemetry)

| event | tracks |
|---|---|
| `settings_open` | how often users open settings |
| `settings_change` | which knob changed, from → to |
| `settings_reset` | tab vs all-reset |
| `advanced_disclosed` | how many users dig past the 2 knobs |

Goal: ≥ 95% of users never click ▸ Advanced. If telemetry shows 30%+ disclosing, the 2-knob mapping is wrong.

---

## §9 Out of scope

**Mobile UX** — explicitly NOT on the Tangerine roadmap. v1.9 §8 + v2.0 §9 both push mobile to "v2.5+" with the framing "desktop dogfood not done; mobile would dilute focus." This spec inherits that. The browser extension covers casual mobile use cases via responsive web views, but no native mobile app is planned.

**Tablet adaptive layouts** — same reason. Browser ext on tablet works for read-only consumption (PM persona). Native app stays desktop-only.

**Voice-driven UX** — Apple Intel Shortcuts capture (V2_0_SPEC §3.2) is the closest we get. No voice-driven UI navigation planned through v2.5.

**Alternate-UI framework experiments** — staying on Tauri + React + zustand. No Electron, no Native iOS/Android, no PWA path.

**Internationalization** — English first. v2.0 ships English-only AGI templates. Chinese in v2.5 (but spec for Chinese live in `xiaoju101` brand, separate product surface).

**Custom theming / white-label per-team** — Layer 4 only, post-PMF.

---

## §10 Open Questions for CEO

5 design forks where the spec assumes a default but the trade-off is real.

### Q1. Default landing route

After v2.0 ships, default landing on first launch (after onboarding) and subsequent launches:

- **A**: `/home` (graph) — V2_0_SPEC §1.1 default
- **B**: `/today` — chronological feed; safer for new users; less visual punch
- **C**: `/workflow-graph` direct (skip `/home` shell) — power user shortcut
- **D**: user-configurable, default `/home` — polished but adds Settings knob (anti-V2_0_SPEC §5)

Spec assumes **A (`/home`)** but Q3.4 in V2_0_SPEC raises the visual-overwhelm risk for new users. Confirm.

### Q2. Sidebar collapse behavior

Sidebar is currently always-visible. v2.0 adds 3-5 lines of ACTIVE AGENTS, pushing total sidebar height. Two design forks:

- **A**: keep sidebar always-visible; let it grow or scroll
- **B**: collapse sections (HOME / WORK / TEAM / TOOLS / SETTINGS) to icon-only when sidebar is narrow
- **C**: hide sidebar by default on small screens, persistent only on large screens

Spec assumes **A** for now but A breaks on small laptop screens (1280×800 — the 13" MacBook Air the team uses). Confirm.

### Q3. Cmd+K vs new sidebar behavior

v2.0 plans Cmd+K palette (§6.3). Today the sidebar is the only nav primitive. Two forks:

- **A**: Cmd+K is **secondary** to sidebar. Power users discover; casual users never use it. Sidebar handles 90% of nav.
- **B**: Cmd+K is **primary**. Sidebar shrinks to icon-only by default. All routing happens via Cmd+K. Faster for power users; new-user discovery harder.

Spec assumes **A**. Linear and Notion both went with B and it worked. But Tangerine's persona mix includes non-tech PM (Cmd+K alien). Confirm A vs B.

### Q4. Onboarding for return users

When a user with existing memory dir launches the app, do they ever see onboarding again?

- **A**: never (current). Existing memory dir → skip wizard always.
- **B**: show "what's new" banner on first launch after upgrade (v1.6+ already does this for releases).
- **C**: show full wizard if memory dir empty AND no settings file (handles users who deleted memory but kept settings).

Spec assumes **A** + B (covered by WhatsNewBanner.tsx). C is an edge case — confirm if worth handling.

### Q5. System tray on Mac

Mac menubar real estate is contested. The 🍊 icon visibility:

- **A**: always visible (current behavior)
- **B**: hide when paused (`agiParticipation === false`)
- **C**: user-configurable in Settings; default visible

Spec assumes **A**. Some power users will hate the menubar clutter. Linear / Slack default to A; Bartender users hide them. Confirm — and decide whether to expose this as a knob (which violates the 2-knob simplification).

---

*UX_FLOW_SPEC v1.0 draft. Pending CEO ratification. Cross-references locked specs (V2_0_SPEC, SUGGESTION_ENGINE_SPEC v1.9, BUSINESS_MODEL_SPEC v1.0).*
