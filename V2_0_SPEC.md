# V2_0_SPEC — AI-native Team Information OS

> Tangerine v2.0: visualize + organize + coordinate. Not just alignment plumbing — the OS layer for AI-native team workflow chaos.

## 0. North Star

AI-native teams' workflow info is a mess. Sources are everywhere: Discord, Slack, GitHub, Linear, Notion, Calendar, Loom, Zoom, Email, Voice notes. AI tools sprawl: Cursor, Claude Code, Codex, Windsurf, ChatGPT, Claude, Gemini, Copilot, v0, Ollama. Personal agents run silently in background: Cursor sessions on someone's laptop, a Devin instance churning, a Replit agent finishing a PR. Everyone is touching everyone else's work and no one can see it. That mess is Tangerine's job. v1.8 wired the plumbing (10 sources + 10 tool alignment + co-thinker brain + ambient layer). v1.9 disciplined the surface (4 tiers + 10 templates + telemetry). **v2.0 makes the OS visible.** Three pillars: **see** the workflow as a graph, **organize** all of it (including the personal-agent layer 1.9 missed), **coordinate** through a co-thinker that's always on screen, not buried in a markdown file.

**Non-goals:** NOT a chatbot — no "ask me anything" tab. NOT a meeting tool — meetings are one source among 10. NOT a Notion clone — atoms live in the user's git repo, we don't host content. NOT a dashboard for managers — the user is the IC who needs to see what their AI agents and team did while they slept. NOT replacing the suggestion engine — visualization is the persistent surface, suggestions are the proactive overlay.

## 1. The Three Pillars (priority-ordered)

### 1.1 Visualize (head pillar)

Replace the `/today` chronological list with a graph-first home screen. Four graph types, each a tab on the home view.

| graph | nodes | edges | answers |
|---|---|---|---|
| Workflow | people, projects, decisions, agents | info-flow (mention, edit, assign, depend) | "where is work flowing right now?" |
| Decision lineage | decision atoms | source → derived → committed | "where did this decision come from / where did it land?" |
| Social | team members + external participants | mention freq, context overlap, time-decayed weight | "who's working with whom this week?" |
| Project topology | projects + sub-projects + atoms | ownership, dependency, status | "what's blocked, what's idle?" |

The graph is the home screen. `/today` becomes a fallback view via tab toggle.

### 1.2 Organize

The 10 sources are kept (Discord/Slack/GitHub/Linear/Notion/Calendar/Loom/Zoom/Email/Voice notes — all in `app/src/lib/sources.ts`). v1.8 covers them. v2.0 adds **Layer 3: personal AI agent capture** — the missing channel where Cursor sessions, Claude Code conversations, Devin instances, Replit agents, and Apple Intelligence Shortcuts run today and leave no trace in team memory. This is bigger than a new source: it requires a memory directory split (`/personal/{user}/` vs `/team/`) and a promote-to-team flow.

### 1.3 Coordinate

Co-thinker stops hiding in `brain.md`. v1.8 writes the doc; user has to navigate to `/co-thinker` to see it. v2.0 surfaces the co-thinker in a persistent home strip (top of every route) plus an activity card on the home screen. Suggestion engine from v1.9 (chip/banner/toast/modal + 10 templates) inherits unchanged.

## 2. Visualization architecture

### 2.1 Workflow Graph (home screen)

**Files to create:**
- `app/src/routes/home.tsx` — new default route, replaces `/today` as landing
- `app/src/components/graph/WorkflowGraph.tsx` — main graph renderer
- `app/src/components/graph/GraphTabs.tsx` — workflow / lineage / social / topology toggle
- `app/src/lib/graph.ts` — graph data builder; reads memory tree + telemetry + agent activity, emits `{ nodes, edges }`
- `app/src-tauri/src/graph/builder.rs` — heavy lift on Rust side, called via Tauri command `graph_build`

**Files to modify:**
- `app/src/App.tsx` — change default route from `/today` to `/`
- `app/src/components/layout/Sidebar.tsx` — add "Home" entry above current "Today"

**Rendering library:** `reactflow` v11. Reasons:
- Maintained, TS-native, MIT
- Built-in pan/zoom/minimap/edge-routing — no custom layout code
- Compatible with zustand (we already use it in `lib/store.ts`)
- 5 KB gz core; cytoscape.js is 60 KB and DOM-heavier

Cytoscape.js considered as fallback if reactflow's auto-layout fails on >500-node graphs.

**Data shape:**
```ts
type GraphNode = {
  id: string;                  // stable, e.g. "person:daizhe" / "atom:decisions/foo.md"
  kind: "person" | "project" | "decision" | "agent" | "atom";
  label: string;
  weight: number;              // size hint, 0..1
  meta: Record<string, unknown>;
};
type GraphEdge = {
  from: string;
  to: string;
  kind: "mention" | "edit" | "assign" | "depend" | "derived_from";
  weight: number;              // 0..1, time-decayed
  ts: string;                  // ISO
};
```

**Performance budget:** initial render < 500ms p95 for graphs up to 300 nodes / 1000 edges. Above that, the Rust builder paginates by recency window (last 7d default, user can extend).

### 2.2 Decision Lineage Tree

**Files:**
- `app/src/components/graph/DecisionLineage.tsx`
- `app/src-tauri/src/graph/lineage.rs`

A directed tree per decision atom. Root = the decision; ancestors = source atoms (transcript lines, RFC drafts, prior decisions); descendants = downstream atoms (commits, channel posts, follow-up decisions).

Lineage edges already exist implicitly in v1.8: `canvas_writer.rs` creates atoms with frontmatter `source_refs:` lines. v2.0 promotes these to first-class graph edges.

**Tauri command:** `graph_lineage(atom_path) → LineageTree`

### 2.3 Social Graph

**Files:**
- `app/src/components/graph/SocialGraph.tsx`
- `app/src-tauri/src/graph/social.rs`

Edge weight formula: `mention_count * decay(t) + context_overlap`, where:
- `mention_count` = direct @-mention or co-occurrence in same atom in last 30d
- `decay(t) = exp(-t / 7d)` so a mention 7d ago weighs ~37% of one made now
- `context_overlap` = number of atoms both nodes touched (read or wrote)

Nodes pulled from `people/` directory in memory tree (v1.8 already maintains this). External participants (guest emails, Discord users without aliases) appear as low-weight peripheral nodes.

### 2.4 Project Topology

**Files:**
- `app/src/components/graph/ProjectTopology.tsx`
- `app/src-tauri/src/graph/topology.rs`

Reads `projects/` dir in memory tree. Each project = node; sub-projects, decisions, action items = child nodes. Edge kinds: `owns`, `depends_on`, `blocks`. Status colors: green (active edits last 7d), yellow (idle 7-21d), red (stale > 21d), gray (done).

## 3. Active agents feed

### 3.1 Sidebar ACTIVE AGENTS section

**Files to create:**
- `app/src/components/sidebar/ActiveAgents.tsx`
- `app/src/lib/agents.ts` — polling client
- `app/src-tauri/src/agents/mod.rs` — capture orchestrator
- `app/src-tauri/src/agents/cursor.rs`
- `app/src-tauri/src/agents/claude_code.rs`
- `app/src-tauri/src/agents/devin.rs`
- `app/src-tauri/src/agents/replit.rs`
- `app/src-tauri/src/agents/apple_intel.rs`

**Files to modify:**
- `app/src/components/layout/Sidebar.tsx` — insert ACTIVE AGENTS section between AI TOOLS and ADVANCED

**Render:**
```
ACTIVE AGENTS (3)
  ● Cursor — daizhe · "patent-21 review" · 3m ago
  ● Claude Code — hongyu · "iFactory MES adapter" · idle
  ○ Devin — team · "tax-101 PR" · running 18m
```

`●` = active in last 60s; `○` = running but quiet; absent = no live session in last hour.

**Poll cadence:** Tauri command `agents_status` polled every 10s from React. Rust side maintains a watch on each agent's log/file/API; Tauri command returns the cached state cheaply.

### 3.2 Capture sources for personal agents

| agent | capture method | path / endpoint |
|---|---|---|
| Cursor | tail conversation log files | `~/.cursor/conversations/*.json` (macOS/Linux), `%APPDATA%/Cursor/User/conversations/` (Windows) |
| Claude Code | tail project memory dirs | `~/.claude/projects/*/MEMORY.md`, `~/.claude/sessions/*.jsonl` |
| Devin | webhook subscriber | configurable webhook URL; user pastes Devin webhook secret in Settings |
| Replit | API poll | `https://replit.com/api/agent/v1/sessions?owner={user}`; user pastes API token |
| Apple Intelligence | Shortcuts hook | user installs a Tangerine Shortcut that POSTs `{ action, ts }` to local daemon |

Where files don't exist or APIs aren't authed, the row stays empty — not an error.

### 3.3 Personal vault structure

The single memory dir splits into two roots:

```
<root>/
  personal/
    daizhe/
      cursor/
        2026-04-26-patent-21.md     # one atom per Cursor conversation
      claude-code/
        2026-04-26-mes-adapter.md
      shortcuts/
        2026-04-26-quick-note.md
    hongyu/
      ...
  team/                              # everything v1.8 already wrote
    meetings/
    decisions/
    people/
    projects/
    threads/
    glossary.md
```

**Migration:** on first v2.0 launch, existing files are kept at root and the loader treats them as `team/`. New atoms route by source: personal-agent atoms → `personal/{currentUser}/`; team-source atoms (Discord, Slack, etc.) → `team/`.

**Files to modify:**
- `app/src/lib/memory.ts` — `readMemoryTree` returns segmented tree
- `app/src-tauri/src/agi/canvas_writer.rs` — write path picks `personal/` vs `team/` from atom kind
- `app/src/lib/store.ts` — add `MemoryConfig.personalDirEnabled: boolean`, default true

**Privacy rules:**
- `team/` syncs to git remote (existing v1.6 behavior)
- `personal/` is `.gitignore`d by default — never leaves the device unless promoted
- Co-thinker brain doc reads from both but only writes to `team/brain.md`
- Suggestion engine telemetry from `personal/` atoms gets a `source: "personal"` flag and is NEVER cloud-synced (extends v1.9 §2.3 privacy rule)

### 3.4 Promote-to-team flow

**Files:**
- `app/src/components/personal/PromoteCard.tsx`
- `app/src-tauri/src/agi/promote.rs`

When a `personal/` atom is detected as team-relevant, the suggestion engine fires a chip: `🍊 This Cursor session looks team-relevant — share to /team/decisions/?`. One click copies the atom (with provenance frontmatter `promoted_from: personal/...`) into `team/`, commits, syncs.

**Detection signals:** atom mentions ≥ 2 team members, or touches a `team/decisions/` topic_key, or duration > 30 min and length > 500 tokens. Rule-based, < 10ms (consistent with v1.9 §1 discipline 5).

**False-positive guard:** confidence floor 0.85; user dismiss × 3 → suppress for that atom for 30d, same as v1.9 telemetry rule.

## 4. Co-thinker dashboard surface

### 4.1 Home screen "AGI strip"

**Files:**
- `app/src/components/co-thinker/AgiStrip.tsx`
- mounted in `app/src/components/layout/AppShell.tsx` above route content, below header

A 36px-tall persistent strip. Top of every view (not just home). Like ChatGPT's model indicator — never disappears, never claims a click unless user chooses.

**Render:**
```
🍊 Last heartbeat 4m ago · 3 observations today · 2 proposals queued · [click to dive]
```

When `agiParticipation === false`, strip collapses to:
```
🍊 paused · [enable]
```

### 4.2 Activity summary card

**Files:**
- `app/src/components/co-thinker/AgiActivityCard.tsx`
- mounted on `home.tsx` as the second tile (graph is first)

Card content:
- Last heartbeat timestamp (read from `co_thinker.rs::last_heartbeat_ts`)
- Observations today (count from `agi/observations.rs`)
- Proposals queued (count from `propose_lock.rs`)
- "AGI noticed 3 things this morning" — top 3 highest-confidence observations as 1-line summaries
- "Click to read" links to `/co-thinker` route (existing v1.8 view)

### 4.3 Click-to-dive navigation

| strip / card click | destination |
|---|---|
| heartbeat label | `/co-thinker` (full brain doc view) |
| observations count | `/co-thinker?tab=observations` |
| proposals count | `/co-thinker?tab=proposals` |
| "AGI noticed X" line | the underlying atom in `/memory` |
| graph node click | atom view or person view |
| graph edge click | the source atom that created the edge |

## 5. Settings simplification

v1.8 has 8 AGI-related controls (master toggle, volume, channel mutes, confidence threshold, dismiss memory, snooze, sample seed banner, what's-new). v2.0 cuts to 2 user-visible knobs. Internal defaults stay tunable in `lib/ambient.ts` for power-users editing config.

| v1.8 control | v2.0 fate |
|---|---|
| `agiParticipation` master toggle | **KEEP** as Knob 1 |
| `agiVolume` (quiet/normal/loud) | merged into Knob 2 (sensitivity) |
| `mutedAgiChannels` per-channel mutes | hidden behind "Advanced" disclosure; defaults work for 95% |
| `agiConfidenceThreshold` 0.5–0.95 slider | merged into Knob 2 (sensitivity) |
| dismiss / snooze / sample / whats-new | not user-visible; internal state |

**Knob 1: master toggle** — `agiParticipation` boolean, unchanged from v1.8.
**Knob 2: sensitivity slider 0–100** — single integer mapped internally:
- 0–33 → quiet volume + confidence floor 0.85
- 34–66 → normal volume + 0.7 floor (default = 50)
- 67–100 → loud volume + 0.6 floor

**Files to modify:**
- `app/src/pages/settings/` — collapse AGI page to 2 controls + Advanced disclosure
- `app/src/lib/store.ts` — add `agiSensitivity: number` (0–100), keep old fields as derived getters for backward compat
- `app/src/lib/ambient.ts` — read `agiSensitivity` instead of separate volume + threshold

## 6. Implementation Phasing

### v2.0-alpha.1 (week 1-2) — memory dir layered
- Add `personal/` + `team/` split with migration shim in `lib/memory.ts`
- Update `canvas_writer.rs` write-path routing
- New `MemoryConfig.personalDirEnabled` field (default true)
- `.gitignore` template includes `personal/` line
- Tests: existing files load as `team/` after migration; new personal atoms isolated

### v2.0-alpha.2 (week 2-4) — workflow graph home screen
- New `home.tsx` route + `WorkflowGraph.tsx` component + `graph.ts` builder + `graph/builder.rs`
- Replace `/today` as default landing; keep `/today` reachable
- Sidebar "Home" entry
- 300-node performance benchmark in `app/src-tauri/benches/graph.rs`
- Acceptance: graph renders in < 500ms p95 for sample memory tree (~150 atoms)

### v2.0-beta.1 (week 4-6) — lineage + social + topology
- 3 graph variants behind `GraphTabs` toggle
- Tauri commands: `graph_lineage`, `graph_social`, `graph_topology`
- Per-graph storybook stories
- Acceptance: each graph builds + renders; tab switching < 200ms

### v2.0-beta.2 (week 6-8) — personal agent capture + ACTIVE AGENTS sidebar
- 5 capture modules in `agents/` (Cursor, Claude Code, Devin, Replit, Apple Intel)
- Sidebar ACTIVE AGENTS section
- Promote-to-team chip via suggestion engine (new template `personal_team_relevant`)
- Acceptance: a live Cursor session on the dev machine appears in sidebar within 30s; promote chip fires when a session mentions ≥ 2 team members

### v2.0-beta.3 (week 8-10) — co-thinker home strip + Settings simplification + onboarding cut
- `AgiStrip.tsx` mounted in AppShell
- `AgiActivityCard.tsx` on home screen
- Settings page reduced to 2 knobs
- Onboarding: Solo/Team/Existing 3-way → Solo default + skip-to-home; Team setup behind "I have a team" link
- Acceptance: first-launch user lands on home graph in < 30s after install

### v2.0 final (week 10) — polish + ship public
- Visual polish, dark mode pass on all graph views
- README update for v2.0 narrative (information OS framing)
- v1.8 → v2.0 migration guide for existing users
- CHANGELOG entry; tag and ship

## 7. Acceptance Grid (CEO 验收)

### v2.0-alpha.1
| # | check | mechanism |
|---|---|---|
| A1 | Existing memory loads at `team/` after migration | integration test: copy v1.8 sample tree → assert all paths reachable |
| A2 | New personal-agent atom routes to `personal/{user}/` | unit test on `canvas_writer` |
| A3 | `personal/` not pushed to git | check `.gitignore` + integration test on `gitInitAndPush` |

### v2.0-alpha.2
| # | check | mechanism |
|---|---|---|
| B1 | Graph renders < 500ms p95 for 300 nodes | criterion bench |
| B2 | First-launch lands on home screen with graph visible | e2e test |
| B3 | Sidebar "Home" entry navigates correctly | unit test |

### v2.0-beta.1
| # | check | mechanism |
|---|---|---|
| C1 | All 4 graph types render from sample data | storybook visual regression |
| C2 | Lineage tree edges trace to source atoms | unit test on `graph/lineage.rs` |
| C3 | Social graph weight decay correct | unit test on weight formula |

### v2.0-beta.2
| # | check | mechanism |
|---|---|---|
| D1 | Cursor live session detected in < 30s | integration test (mock log file) |
| D2 | Promote chip fires only at confidence ≥ 0.85 | property test |
| D3 | Promoted atom retains provenance frontmatter | unit test |
| D4 | ACTIVE AGENTS hidden when no agents detected | UI test |

### v2.0-beta.3
| # | check | mechanism |
|---|---|---|
| E1 | AgiStrip visible on every route | e2e test, navigate all 8 routes |
| E2 | Sensitivity slider maps to correct (volume, threshold) | unit test on store |
| E3 | Solo onboarding skips to home in 1 click | e2e test |
| E4 | Knob 2 advanced disclosure exposes per-channel mutes | UI test |

## 8. Dependencies + Coordination

| dependency | status | required for |
|---|---|---|
| v1.9 SUGGESTION_ENGINE shipped (4-week prereq) | in progress | promote chip in beta.2 reuses tier engine |
| BUSINESS_MODEL_SPEC v1.0 | LOCKED | unchanged; Layer 2 inference billing not affected by v2.0 |
| co-thinker `brain.md` format | stable | AgiStrip reads existing fields; no schema change |
| Memory tree schema | stable | extended with `personal/` prefix; backward compat |
| `reactflow` (new dep) | not added | needs `pnpm add reactflow@^11.10` in `app/package.json` |

**Cross-spec contracts:**
- v1.9 templates table extends to **11 templates** (add `personal_team_relevant`); rest of v1.9 spec untouched.
- v1.9 telemetry payload gets new field `source: "personal" | "team"` — backward compatible (optional).
- BUSINESS_MODEL Layer 1 OSS scope extends to include the personal-agent capture modules. No license change.

## 9. Out of Scope (push to v2.5+)

| pushed item | original target | new target | reason |
|---|---|---|---|
| Marketplace (Layer 3) | v3.0 (BUSINESS_MODEL §2.3) | v3.5 | Releases 8-10 weeks for v2.0 visualization + agent layer; marketplace blocked on PMF anyway |
| Decision review PR-style workflow | v2.0 | v2.5 | Separate from visualization scope; needs its own design pass |
| Partnership embedded SDK | v2.0 | v2.5 | Customer demand not yet validated; OSS path covers most cases |
| Mobile (read-only viewer) | v2.x | v2.5+ | Desktop dogfood not done; mobile would dilute focus |
| Cross-team / public canvas share | v2.x | v2.5+ | Privacy + auth model needs separate spec |
| Suggestion ranking via user feedback ML | v2.0 | v2.5+ | Need 3+ months of v1.9 telemetry first |
| Multi-language suggestion templates | v2.0 | v2.5+ | English-only ships first |

## 10. Risks + Mitigations

| # | risk | likelihood | impact | mitigation |
|---|---|---|---|---|
| 1 | Graph perf regression on >500-node memory trees | high | high | Reactflow pagination by recency window; Rust builder respects 7d default; lazy-load older nodes on pan; criterion bench in CI gates beta.1 |
| 2 | Personal agent privacy leak (Cursor/Claude Code logs accidentally pushed) | low | critical | `.gitignore` includes `personal/` by default; integration test asserts; cloud-sync of telemetry strips `source: "personal"` rows |
| 3 | Cursor / Devin / Replit log format breaks on next version | high | medium | Capture modules versioned + feature-flagged; if format detection fails, row hides silently rather than crashes; auto-PR on user reports |
| 4 | Promote-to-team flow false positives (private notes promoted to public) | medium | high | Confidence floor 0.85; user always confirms via chip click; never auto-promote; dismiss × 3 → 30d suppress |
| 5 | Dashboard overload (graph + AgiStrip + sidebar agents + suggestions = visual noise) | medium | medium | AgiStrip 36px and read-only; sidebar agents collapsible; suggestion engine still gated by single-active-queue (v1.9 §1 discipline 1); A/B test home density before final |
| 6 | reactflow bundle size (5 KB → 50 KB w/ extras) | low | low | Tree-shake; lazy-load graph route via React.lazy; current bundle has 200 KB headroom |
| 7 | v2.0 alpha breaks v1.8 user repos (memory dir migration) | low | high | Migration is read-only on first launch; original files stay at root; rollback = revert app version |

## 11. Open Questions for CEO

1. **Default graph on home screen** — workflow graph (broad), decision lineage (narrow), or user-pinnable? Spec assumes workflow graph default with tab toggle. Trade-off: workflow is information-rich for power users, can overwhelm new users.
2. **Personal agent capture opt-in vs default-on** — spec assumes Tangerine auto-captures Cursor / Claude Code from default file paths the moment app launches. Privacy purist alternative: explicit opt-in per agent in Settings before capture starts. Trade-off: default-on = better demo + more atoms; opt-in = cleaner privacy story.
3. **Promote-to-team ownership** — when an atom from `personal/daizhe/` promotes to `team/`, does the team file note it was Daizhe's session, or just the topic? Spec assumes provenance frontmatter `promoted_from: personal/daizhe/...` is visible to team. Counter: some users may want anonymized promotion. Confirm.
4. **Graph performance ceiling** — at what node count do we stop trying to fit the whole graph and require user-driven filtering? Spec assumes 300 nodes auto-rendered, 300+ paginated. Could be too aggressive for power users with 10k-atom memory trees.
5. **AgiStrip when AGI is paused** — strip currently collapses to `🍊 paused · [enable]`. Should it disappear entirely so user reclaims the 36px? Spec keeps it visible (preserves "AGI presence" property). Counter: users who explicitly paused want maximum quiet.

---

*V2_0_SPEC v1.0 draft. Pending CEO approval. v1.9 SUGGESTION_ENGINE is hard prereq; do not begin v2.0 alpha.1 until that ships.*
