# V3_0_SPEC — Layer 3 Personal Agent Capture + Layer 6 External World

> Tangerine v3.0: every agent the user uses, we see. Every external thing the user reads, we write into memory. The team OS gets eyes outside its own walls.

## 0. North Star

v2.0 made the OS visible — graphs, ACTIVE AGENTS sidebar, co-thinker strip, `personal/` vs `team/` split. v2.5 paywalls the inference layer. **v3.0 closes two holes:** (1) personal AI agents — Cursor, Claude Code, Devin, Replit, Apple Intelligence, Copilot — leave traces on disk and remote servers nobody else on the team can see, and (2) external information — X bookmark, RSS post, podcast, YouTube — never lands in team memory either. Both reshape what the user thinks. Both invisible.

v3.0 captures both. **Agents the user uses, we see. Sources the user reads, we write down.** Output of every channel = atom in `personal/{user}/threads/`, indistinguishable from a Discord message in shape, full participant in graph + co-thinker + suggestion engine.

**Non-goals:** NOT an agent dispatcher — capture only, never modify behavior. NOT a content recommender — pull-only, user picks sources. NOT a cloud uploader — personal vault stays on device unless promoted (v2.0-alpha.1 rule preserved). NOT a bookmarking tool replacement — atoms are side effect, not primary UI.

## 1. Personal Agent Capture per Source

Each agent gets its own Rust capture module under `app/src-tauri/src/agents/`, registered in `mod.rs`, polled by the orchestrator at 10s active / 60s idle (v2.0-beta.2 cadence preserved). Output atom path: `personal/{user}/threads/{source-type}/{ts}-{slug}.md`. Frontmatter: `agent: {id}`, `session_id: {agent-native-id}`, `started_at`, `last_activity`, `token_count`, `topic_keys: []`.

### 1.1 Cursor

Read `~/.cursor/conversations/*.json` (macOS / Linux), `%APPDATA%/Cursor/User/conversations/*.json` (Windows). Watch via `notify` crate (`RecommendedWatcher::watch(path, RecursiveMode::Recursive)`). Format: JSON with `messages: [{ role, content, timestamp }]`, top-level `id` + `title`. Module `agents/cursor.rs::capture_session(path) → CursorAtom`. Write atom per session, updated on mtime change (5s debounce). Atom kind `personal_agent.cursor`.

### 1.2 Claude Code

Read `~/.claude/conversations/*.jsonl` and `~/.claude/projects/*/MEMORY.md`. Same `notify` watcher; `.jsonl` is append-only, tail by byte-offset cursor. Format: JSON-Lines, one event per line — `{ type: "user_message" | "assistant_message" | "tool_use", ... }`. Module `agents/claude_code.rs::tail_session(path, offset) → (events, new_offset)`. Write atom per session id, append events into `events:` block. Atom kind `personal_agent.claude_code`.

### 1.3 Codex CLI

Read `~/.config/openai/sessions/*` if it exists (no-op until first session lands). Watch via `notify` on parent dir, fall back to 60s scan. Format: OpenAI session JSON, version-detect via `schema_version` field, fail-soft on mismatch. Module `agents/codex.rs::scan_sessions()`. Atom kind `personal_agent.codex`.

### 1.4 Windsurf

Read `~/Library/Application Support/Windsurf/sessions/*.json` (macOS), `%APPDATA%/Windsurf/sessions/` (Windows). Format mirrors Cursor (same Codeium fork lineage); reuse Cursor parser with `mode: "windsurf"` flag. Module `agents/windsurf.rs` (thin wrapper over `cursor.rs::parse_messages`). Atom kind `personal_agent.windsurf`.

### 1.5 Claude.ai web

Browser extension, not file-tail. v1.8 Phase 1 ext already injects 🍊 button into chat input — v3.0 extends with conversation history scrape.

- **Mechanism:** content script reads `https://claude.ai/api/organizations/{org}/chat_conversations/{id}` via the user's logged-in session — same JSON API the web UI consumes, no HTML scraping
- **Trigger:** every 60s while on `claude.ai/chat/*`, plus on navigation
- **Transport:** ext POSTs to `http://127.0.0.1:7717/agents/claude_ai/ingest` (port 7717 reused from v1.8 daemon)
- **Module:** `agents/claude_ai.rs::ingest(payload)` — atom kind `personal_agent.claude_ai`
- **Privacy gate:** fires only when `personalCaptureEnabled.claude_ai === true`; opt-in default (§5)

### 1.6 ChatGPT web

Same pattern as 1.5. Content script reads `https://chatgpt.com/backend-api/conversation/{id}` via session. Fallback if rate-limited: OpenAI export ZIP, user-driven, captured as bulk import via Settings → "Import ChatGPT history". Module `agents/chatgpt.rs`. Atom kind `personal_agent.chatgpt`.

### 1.7 Gemini web

Same pattern as 1.5, against `https://gemini.google.com/_/BardChatUi/data/...` endpoints. Schema more brittle than Claude / ChatGPT — capture module versioned, fail-soft on schema mismatch, errors land in Settings → "Capture Health". Module `agents/gemini.rs`. Atom kind `personal_agent.gemini`.

### 1.8 Devin instance

Webhook subscriber. Tangerine local daemon exposes `127.0.0.1:7717/agents/devin/webhook` + a tunneled URL via the v1.8 ngrok-style relay (or user's own reverse proxy in self-hosted mode); user pastes URL + shared secret into Devin settings. Plus scheduled poll every 5min via Devin REST API (`https://api.devin.ai/v1/sessions?owner={user}`) as backup. Module `agents/devin.rs::handle_webhook(payload)` + `poll(token)`. Token in OS keychain (Settings → Devin → Connect). Atom kind `personal_agent.devin`.

### 1.9 Replit Agent

REST poll: 30s active, 5min idle. Endpoint `https://replit.com/api/agent/v1/sessions?owner={user}`. Token in OS keychain. Module `agents/replit.rs::poll(token)`. Atom kind `personal_agent.replit`.

### 1.10 Apple Intelligence (macOS Shortcuts)

- **Mechanism:** post-action hook. User installs a Tangerine Shortcut from `share.icloud.com/shortcuts/tangerine-capture` (one-tap) that runs after any Shortcuts action (Writing Tools, Image Playground, Genmoji, Notification summarization)
- **Transport:** Shortcut POSTs `{ action, ts, input_excerpt, output_excerpt }` to `http://127.0.0.1:7717/agents/apple_intel/hook`
- **Module:** `agents/apple_intel.rs::hook(payload)`. Atom kind `personal_agent.apple_intel`. macOS only — Windows row hidden.

### 1.11 MS Copilot personal

Microsoft Graph API `/me/copilot/interactions` (enterprise license required). OAuth via Microsoft Entra; token in OS keychain. Module `agents/ms_copilot.rs::poll(token)` — **stub in v3.0 final**: code skeleton + auth flow + UI row, capture loop returns "license required" until enterprise customer asks. Atom kind `personal_agent.ms_copilot`.

## 2. External World Capture (Layer 6)

What the user reads reshapes what the user thinks. v3.0 catches it. All Layer 6 atoms write to `personal/{user}/threads/external/{source-type}/{ts}-{slug}.md` with frontmatter `source_type`, `source_url`, `consumed_at`, `summary`, `topic_keys: []`.

### 2.1 Twitter / X bookmarks

No scraping — X blocks scrapers and the user's account is not for sale. Mechanism: Nitter RSS (`https://nitter.{instance}/{handle}/rss`) for public posts; for bookmarks specifically, watch the Downloads folder for X archive ZIPs (`twitter-*.zip`) — user one-clicks `Settings → Your Account → Download an archive of your data`, Tangerine parses `bookmarks.js`. Module `external/twitter.rs::parse_archive(path)` + `poll_rss(handle)`. Atom kind `external.twitter`.

### 2.2 RSS feeds

Any RSS / Atom URL — user adds via Settings → Sources → Add RSS Feed. Library `feed-rs`. Poll every 15min per feed; respects `<ttl>`. Module `external/rss.rs::poll_feed(url) → Vec<Atom>`. ETag + last-modified per feed in `personal/{user}/threads/external/rss/.cursors.json`. Atom kind `external.rss`.

### 2.3 Podcast (Whisper transcribed)

Podcast RSS URL; Tangerine downloads new episodes (mp3), runs Whisper locally. Backend `whisper.cpp` (shipped with v1.8 voice notes); model `base.en` default, `small.en` opt-in. Cost: local CPU, ~1min audio = 30s wall on M1; flagged "transcribing" in ACTIVE AGENTS. Module `external/podcast.rs`. Atom kind `external.podcast` — transcript in body, summary in frontmatter. Off by default per feed (heavy).

### 2.4 YouTube

User pastes URL into Settings → External → "Capture YouTube", or via deep-link `tangerine://capture/youtube?url=...` (registered URL handler). Pipeline: `yt-dlp` audio → `whisper.cpp` → atom. Module `external/youtube.rs::capture(url)`. Atom kind `external.youtube`.

### 2.5 Generic web article

Bonus, falls out of RSS infra. User clicks browser-ext "Save to Tangerine"; ext grabs `<article>` via Readability.js, POSTs to `127.0.0.1:7717/external/article/ingest`. Module `external/article.rs`. Atom kind `external.article`.

## 3. ACTIVE AGENTS Sidebar — Extended

v2.0-beta.2 shipped a 3-line render (cursor / claude-code / devin / replit / apple_intel). v3.0 extends to **status + last-activity + click-to-thread**.

### 3.1 Render

```
ACTIVE AGENTS (5)
  ● Cursor — daizhe · "patent-21 review" · 3m ago        [thread →]
  ● Claude Code — hongyu · "MES adapter" · idle 8m       [thread →]
  ◐ Devin — team · "tax-101 PR" · running 18m            [thread →]
  ⊘ Replit — daizhe · "auth-error" · ERROR 2m ago        [thread →]
  ● Apple Intel — daizhe · 2 actions today               [thread →]

EXTERNAL (3 sources)
  ● RSS — 4 new today                                    [feed →]
  ● Podcast — Lex Fridman ep 421 transcribing            [feed →]
  ⊘ X — auth expired                                     [reconnect →]
```

**Status glyphs:**
- `●` active in last 60s
- `◐` running but no events in 5min
- `○` idle (last event 5–60min ago)
- `⊘` error (capture failed; click for details)
- absent = no live session in last hour

**Last-activity ts:** rolling, in user's local tz, "Xm ago" / "Xh ago" / `HH:MM` if > 24h.

### 3.2 Cross-team visibility

Per-user agent list is owner-private by default. Toggle in Settings → Privacy → "Share agent presence with team": when on, the team-aggregate view shows aliased rows under a `TEAM AGENTS` collapsible section (default collapsed):

```
▾ TEAM AGENTS (4 active)
  daizhe · 2 agents
  hongyu · 1 agent
  david · 1 agent
```

Click a name → see that user's currently-running agents (presence only — names + duration, never thread content). Thread content stays on owner's device unless promoted (§4).

### 3.3 Poll cadence

- **Active (window focused, agent showed event in last 60s):** 10s
- **Idle (window focused, no event > 60s):** 30s
- **Background (window unfocused):** 60s
- **Sleep (machine asleep / app suspended):** capture pauses; resumes on wake with delta-tail from saved cursor

### 3.4 Click → thread atoms

`[thread →]` opens the right-pane drawer pre-loaded on the latest atom for that agent / external source. v2.0 graph node click already does this for graph nodes; reuse `MemoryAtomDrawer.tsx`.

## 4. Promote-to-team Flow

v2.0-beta.2 shipped a basic chip with rule-based detection (≥ 2 team members mentioned, etc., confidence ≥ 0.85). v3.0 upgrades to **co-thinker auto-suggest with team_relevance score**.

### 4.1 Atom move + provenance

Promote = copy atom from `personal/{user}/threads/{src}/{name}.md` to `team/{target-bucket}/{name}.md`. Provenance frontmatter preserved:

```yaml
promoted_from: personal/daizhe/threads/cursor/2026-04-26-patent-21.md
promoted_by: daizhe
promoted_at: 2026-04-26T14:30:22Z
team_relevance: 0.87
target_bucket: decisions
```

Original atom in personal vault stays — promotion is a copy + provenance link, never a move. User can re-promote with edits.

### 4.2 Co-thinker auto-suggest

Co-thinker heartbeat (every 5min, runs in v1.8) extends to tag personal atoms with `team_relevance: 0–1`. Score formula:

- +0.4 if atom mentions ≥ 2 team members by alias
- +0.3 if atom touches existing `team/decisions/{topic}.md` `topic_keys`
- +0.2 if atom length > 500 tokens
- +0.1 if atom session duration > 30 min
- +0.2 if atom contains "we should" / "let's" / "todo" / decision verbs (regex)
- −0.3 if atom marked `private: true` in frontmatter (user-set)

Floor 0, ceiling 1.

### 4.3 Threshold + chip

When `team_relevance > 0.7`, suggestion engine fires:

```
🍊 Tangerine suggests promoting "patent-21 review" to /team/decisions/
   [confirm] [edit target] [dismiss] [never for this session]
```

One click `confirm` → atom copied + commit + sync. Edit-target opens a picker (decisions / projects / threads / glossary). Dismiss × 3 → suppress for that atom 30d (v1.9 telemetry rule).

### 4.4 Audit log

Every promotion writes a row to `team/.tangerine/promotion-log.jsonl`:

```json
{"ts":"2026-04-26T14:30:22Z","by":"daizhe","from":"personal/daizhe/threads/cursor/...","to":"team/decisions/...","relevance":0.87,"reason":"chip-confirmed"}
```

Read by Settings → Audit page, filterable by user / source / target.

## 5. Privacy + Opt-in Defaults

### 5.1 Per-source toggle

Settings → Privacy → Personal Capture page lists every source from §1 + §2 with a single toggle:

```
[x] Cursor                    last captured 2m ago
[x] Claude Code               last captured idle
[ ] Codex CLI                 not detected
[x] Windsurf                  last captured 12m ago
[x] Claude.ai (browser)       last captured 5m ago
[x] ChatGPT (browser)         last captured 1h ago
[ ] Gemini (browser)          off
[x] Devin                     connected via webhook
[ ] Replit                    not connected — [connect]
[x] Apple Intelligence        last captured 30s ago (3 today)
[ ] MS Copilot                license required
─────────────────────────
[x] Twitter / X bookmarks     watching Downloads folder
[x] RSS feeds (4 sources)     [manage]
[ ] Podcast                   off
[ ] YouTube                   off (paste-to-capture only)
```

**Default:** opt-in per source — first-launch wizard asks the user to pick which sources to capture (§6.1 phasing has the UI). Sources with detected files (`~/.cursor/conversations/` exists) are pre-checked; sources requiring auth (Devin / Replit / MS Copilot) are unchecked.

### 5.2 Personal vault never syncs

Reuses v2.0-alpha.1 `.gitignore` rule: `personal/` is git-ignored at root. Integration test in `app/src-tauri/tests/privacy.rs` asserts `git ls-files | grep '^personal/' == empty` after a full capture cycle.

Telemetry payload (v1.9 §2.3) for personal atoms gets `source: "personal"` flag, **stripped before any cloud transmission** (v2.0 §3.3 rule extended to all 11 + 5 v3.0 sources).

### 5.3 Provenance footer on shared atoms

When an atom is promoted (§4) it gets a footer rendered in any team-side view:

```
---
*Promoted from daizhe's Cursor session on 2026-04-26.*
```

Rendered by `app/src/components/atom/AtomFooter.tsx`, reads `promoted_from` frontmatter. User can opt for **anonymized promotion** in Settings → Privacy → "Anonymize my promotions" — footer shows "Promoted from a team member's Cursor session" instead.

### 5.4 Privacy panic actions

Settings → Privacy → bottom of page:

- **Pause all personal capture** — single button, sets all toggles to off, cancels in-flight watchers, no atoms written until resumed
- **Export personal vault** — zips `personal/{user}/` to a user-chosen path
- **Delete personal vault** — confirmation modal, deletes `personal/{user}/` after a 7-day undoable trash (v1.6 trash mechanism)
- **Clear capture caches** — wipes Whisper-transcribed audio cache + log-file cursors

## 6. Implementation Phasing — 8 weeks

Sequenced after v2.5 paywall ships. v3.0 does not block on v2.5 features; only on v2.5 codebase being on `main`.

### v3.0-alpha.1 (week 1–2) — Cursor + Claude Code log readers + watcher

- `agents/cursor.rs`, `agents/claude_code.rs`, `agents/mod.rs` orchestrator
- `notify` watcher with debounce + tail-by-offset
- Atoms write to `personal/{user}/threads/{cursor|claude_code}/`
- ACTIVE AGENTS sidebar already present from v2.0; no UI change needed yet
- Settings → Privacy stub page (just the toggles, no fancy detection rows)

### v3.0-alpha.2 (week 3–4) — Devin webhook + Replit poll + Codex + Windsurf

- `agents/devin.rs` (webhook + poll combo)
- `agents/replit.rs` (poll only)
- `agents/codex.rs` + `agents/windsurf.rs` (file-tail, reuse Cursor parser)
- Local daemon HTTP routes at `127.0.0.1:7717/agents/{devin,replit}/...`
- OS keychain integration via `keyring` crate for Devin / Replit tokens
- Settings → Privacy gets full source list with detection state

### v3.0-beta.1 (week 5–6) — External world (RSS / podcast / YouTube)

- `external/rss.rs` with `feed-rs` integration
- `external/podcast.rs` + `external/youtube.rs` reusing v1.8 `whisper.cpp` binding
- `external/twitter.rs` watching Downloads folder + Nitter RSS poll
- Settings → Sources page (separate from Privacy) for adding feeds
- `external/article.rs` browser-ext "Save to Tangerine" button

### v3.0-beta.2 (week 7) — Apple Intelligence Shortcuts

- `agents/apple_intel.rs` HTTP hook
- Tangerine Shortcut packaged at `share.icloud.com/shortcuts/tangerine-capture`
- macOS-only UI row; Windows hides
- Onboarding adds "Install Apple Shortcut" step on macOS

### v3.0 final (week 8) — MS Copilot stub + browser-ext extensions + polish + ship

- `agents/ms_copilot.rs` stub (auth flow + UI row + license-required error)
- Browser-ext extensions for Claude.ai / ChatGPT / Gemini conversation history scrape (extends Phase 1 ext from v1.8)
- Cross-team agent presence toggle (§3.2)
- Promote-to-team upgrade with co-thinker auto-suggest scoring (§4.2)
- Onboarding wizard for first-launch source picker
- README v3.0 narrative; CHANGELOG; tag and ship

## 7. Per-phase Acceptance Gates

### v3.0-alpha.1
| # | check | mechanism |
|---|---|---|
| A1 | Live Cursor session detected in < 30s | mock log file integration test |
| A2 | Claude Code `.jsonl` tailed without re-reading | byte-offset cursor unit test |
| A3 | Atoms write to `personal/{user}/threads/cursor/` | path assertion |
| A4 | Watcher survives Cursor restart (file-recreate) | integration test, kill+restart sim |

### v3.0-alpha.2
| # | check | mechanism |
|---|---|---|
| B1 | Devin webhook delivers atom in < 10s | mock POST + assert |
| B2 | Replit poll respects 30s active / 5min idle | scheduler unit test |
| B3 | Token stored in OS keychain, not plaintext | manual + `keyring::Entry::get_password` test |
| B4 | Codex / Windsurf parse without panic on real samples | snapshot test on captured samples |

### v3.0-beta.1
| # | check | mechanism |
|---|---|---|
| C1 | RSS feed produces atom per item | integration test on canned feed |
| C2 | Podcast transcribes 60s sample in < 60s wall on M1 | benchmark |
| C3 | YouTube `tangerine://` deep link routes correctly | URL-handler integration test |
| C4 | X archive parsed; bookmarks become atoms | fixture: real `bookmarks.js` |

### v3.0-beta.2
| # | check | mechanism |
|---|---|---|
| D1 | Shortcut POST hook produces atom in < 5s | curl + assert |
| D2 | macOS-only row hidden on Windows | platform feature flag test |

### v3.0 final
| # | check | mechanism |
|---|---|---|
| E1 | First-launch wizard captures 0 sources unless user picks | e2e test |
| E2 | Promote-to-team chip fires only at `team_relevance > 0.7` | property test |
| E3 | Personal vault git-ignored after full capture | filesystem assertion |
| E4 | Cross-team presence toggle aggregates correctly | multi-user e2e |

## 8. Dependencies

| dependency | status | required for |
|---|---|---|
| v2.0 final shipped | required | base ACTIVE AGENTS sidebar + `personal/` split |
| v2.0-alpha.1 memory dir layered | shipped | `personal/{user}/` write paths |
| v2.5 paywall shipped | required (sequencing only) | v3.0 work begins after v2.5 cuts main |
| Browser ext Phase 1 | shipped | extension extends with conversation history scrape |
| `whisper.cpp` binding | shipped (v1.8 voice notes) | podcast + YouTube transcribe |
| `notify` crate | not added | `cargo add notify@^6` |
| `feed-rs` crate | not added | `cargo add feed-rs@^1` |
| `keyring` crate | not added | `cargo add keyring@^2` |
| `yt-dlp` binary | bundled-on-demand | YouTube ingest; downloaded on first YouTube capture, not at install |

## 9. Out of Scope

| pushed item | reason |
|---|---|
| Cross-team **personal vault** sharing | privacy model needs separate spec; v3.0 only shares presence (§3.2) and promoted atoms (§4) |
| Agent **dispatch / control** | v3.0 captures, never modifies — calling Cursor / Devin / Replit on user's behalf is its own product surface, deferred to v4.x |
| Recommender for external sources | "what should I read?" is a different product; v3.0 only captures what the user already chose |
| Chat history sync **across machines** | per-machine personal vault; cross-machine sync via user's own git private repo if they choose, not Tangerine-native |
| Real-time stream of agent tokens | atoms are the event grain; sub-atom streaming = noise |
| PDF / EPUB capture | v3.5+ — needs OCR and reader-app integration |

## 10. Risks

| # | risk | likelihood | impact | mitigation |
|---|---|---|---|---|
| 1 | **Privacy creepy** — user feels surveilled when ACTIVE AGENTS shows everything they did today | medium | high | Opt-in default; per-source toggle; Pause All; never auto-promote; provenance footer; anonymize option |
| 2 | **File format breakage** — Cursor / Claude Code / Codex change schema in next release | high | medium | Versioned capture modules; schema-detect via top-level field; fail-soft (row hides); Settings → "Capture Health" surfaces failures |
| 3 | **Agent throttle** — Devin / Replit / MS Graph rate-limit polls | medium | medium | Respect `Retry-After`; exponential backoff; longest poll 5min; webhook over poll where available |
| 4 | **Cross-platform** — macOS Shortcuts unavailable on Windows; X archive paths differ; Whisper varies | high | low | Platform feature flags; Whisper model selectable per machine |
| 5 | **Data volume** — heavy user generates 100+ atoms/day, vault grows GB/month | medium | medium | Dedup by session_id; transcripts compressed; auto-archive to `personal/.archive/` after 90d; Settings → "Vault size" + "Trim" |

## 11. Open Questions for CEO

1. **X bookmarks: archive watch vs Nitter.** Spec assumes archive-watch (no Nitter dep, no auth, but slower — user manually downloads archive). Alternative: Nitter RSS if stable instance exists — faster + auto but instance-fragile.

2. **Whisper default model.** `base.en` (39M, fast) vs `small.en` (74M, better). Spec defaults `base.en`. Counter: transcription is already async + heavy, ship `small.en` for accuracy?

3. **Auto-promote suppression.** Spec says never-auto-promote — chip always asks. Counter: if `team_relevance > 0.95` and last 10 chips all confirmed, allow silent auto-promote with daily banner.

4. **Promotion default: attributed vs anonymized.** Spec attributed (footer shows owner). Counter: default anonymized for sensitive personal-agent atoms. Cultural call.

5. **Browser-ext scrape cadence.** Spec assumes 60s while on `claude.ai/chat/*`. Concern: Anthropic / OpenAI / Google rate-limits. Alternative: capture-on-demand (user clicks 🍊 → "Capture this now") — explicit but easy to forget.

---

*V3_0_SPEC v1.0 draft. Pending CEO approval. v2.0 final + v2.5 paywall are hard prereqs; do not begin v3.0-alpha.1 until both are on `main`.*
