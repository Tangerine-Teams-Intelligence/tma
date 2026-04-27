# Tangerine Teams App

> **Align every AI tool on your team with your team's actual workflow.**
>
> Your team uses Cursor, Claude, ChatGPT, Codex, Devin, Copilot — but each AI sees a different slice of what your team's actually doing. We align them all with one source of team workflow. Your AIs stop giving different answers.

[![Latest Release](https://img.shields.io/github/v/release/Tangerine-Teams-Intelligence/tangerine-teams-app?include_prereleases)](https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/latest)
[![License: Apache-2.0 (current)](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](PRIOR-LICENSE-APACHE-2.0.txt)
[![License: AGPL v3 + Commercial (transition)](https://img.shields.io/badge/license-AGPL_v3_+_Commercial-orange.svg)](LICENSE)

**Status**: v1.9.1 internal · v1.8.1 last public release · 4 design moats truly delivered

---

## Why Tangerine — 4 design moats, each with concrete user value

### 1. Borrow your existing AI Pro subscription
**No new $20/seat/month for our LLM.**

You already pay Cursor Pro / Claude Pro / Codex / ChatGPT Plus. Tangerine reverse-calls into your editor through the **MCP sampling protocol** — your existing LLM does the inference, we just route the prompt. Your team pays $0 in extra LLM fees.

If your team has no AI subscription, our DeepSeek-backed fallback runs ~$2-5/team/month flat (not per-seat, not per-token).

How it works (Tauri ⇄ MCP server ⇄ your editor):
```
~/.cursor/mcp.json                                Tangerine WS server
       │                                          127.0.0.1:7780/sampler
       ▼                                                    ▲
  MCP server  ────── register_sampler ────────────────────── │
       │                                                    │
       ◄────── sample (prompt + system) ───────── Tauri co-thinker
       │
  server.createMessage()  (reverse-call to Cursor's host LLM)
       │
       └────── sample_response (LLM output) ──────────────► back
```

### 2. AGI brain is a markdown doc — readable, editable, git-able
**No black box. You see exactly what the AGI thinks.**

Open `~/.tangerine-memory/team/co-thinker.md` any time. It's a markdown doc — `cat` it, `vim` it, `git diff` it, push it to your repo. The AGI's "thinking" is a document you can read.

- Heartbeat: every 5 min when team's idle, every 30 min when active
- Don't like what the AGI wrote? Edit the markdown directly. It picks up your edits next heartbeat.
- Diff your AGI's brain across weeks: `git log -p co-thinker.md`

### 3. Cross-vendor AI tool visibility
**Anyone on your team uses any AI tool — we capture it.**

Your designer uses Cursor. Your CTO uses Claude Code. Your contractor uses ChatGPT. Your intern uses Replit. Most tools today see only their own slice. Tangerine reads each vendor's local conversation files and unifies them into one team memory.

8 vendor parsers shipped:
| Vendor | Status | Local files read |
|---|---|---|
| Claude Code | Confirmed working | `~/.claude/projects/<repo>/*.jsonl` (41 sessions / 8483 messages tested) |
| Cursor | Wired, awaiting real-files validation | `~/.cursor/conversations/*.json` |
| Codex | Wired, awaiting validation | `~/.codex/sessions/*.json` |
| Windsurf | Wired, awaiting validation | `~/.windsurf/conversations/*.json` |
| Devin | API-based, needs real token | Cognition API |
| Replit | API-based, needs real token | Replit API |
| Apple Intelligence | macOS-only, awaiting validation | `~/Library/Application Support/com.apple.intelligenceplatform/` |
| MS Copilot | Wired, awaiting validation | M365 Copilot API |

Honest disclosure: only Claude Code is real-files-validated as of v1.9.1. The other 7 parsers compile, have unit tests, and have spec-correct schemas — they just haven't been pointed at real user files yet because we (the dev team) don't have those tools installed. As users install Tangerine + their respective tools, we close each row.

### 4. AI tools as first-class sidebar
**Most apps' sidebars hold workflows. Ours holds AI tools — because that's where the work actually happens.**

Cursor / Claude Code / Codex / Windsurf / ChatGPT / Devin / Replit / Apple Intelligence / MS Copilot / Ollama — all in one sidebar.
- Star your primary tool (it's where new tasks default to)
- See each tool's active session indicator at a glance
- One-click "Copy MCP config to clipboard" for tools that support MCP
- Auto-config card surfaces for installed MCP-compatible tools

---

## Quick start (30 seconds from install)

1. Download installer for your OS:
   - **Windows**: [Tangerine-Teams-App-1.9.1-x64.msi](https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/latest)
   - macOS / Linux: coming v1.9.x (Tauri 2 builds clean, just needs CI runner)
2. Install + launch
3. WelcomeOverlay walks you through 4 cards in ~30 seconds
4. Click "Get started" → auto-detects installed AI tools and surfaces one-click MCP config snippets
5. Initialize co-thinker brain → first heartbeat in ~5-10 seconds

---

## Pricing — transparent because we build in public

Tangerine is **OSS forever**. Run it on your laptop, connect your own DeepSeek API key, never pay us anything. Every feature is open-source, every commit is public. There are no enterprise-only forks hidden behind a paywall.

If you want zero-config + managed everything, four tiers:

| Tier | Price | What you get |
|---|---|---|
| **Self-host** | **$0 forever** | Full app, every feature. Bring your own DeepSeek API key (~$0.27/M tokens at cost) — or borrow your editor's LLM via MCP sampling. Your existing Cursor Pro / Claude Pro / Codex subscription becomes Tangerine's inference engine. |
| **Tangerine Cloud** | **$80 / team / month flat**<br>+ overage credits | Shared DeepSeek API key managed by us. ~100M tokens included monthly (very heavy team usage). Above that, top up with credits at $5 / 10M tokens. **Not per-seat**: invite 5 people or 50, the base price stays $80. |
| **Marketplace** | 82% to sellers / 18% to us | Buy & sell community templates, sources, agents. Sellers set prices; we handle distribution + auth + billing. |
| **Enterprise** | **$50–200k / year** | SOC 2 Type II, SSO, on-prem deployment, white-label, 24h SLA, dedicated account manager. **Required if you redistribute Tangerine inside your products** — AGPL forces it; buy a commercial license to keep your modifications private. |

### Why $80/team flat instead of $20/seat?

Per-seat pricing trains you to "save" by not inviting your full team. Tangerine **only works when everyone is in it** — that's how cross-AI alignment happens. So we charge per-team, not per-seat. Either everyone uses it or no one does.

Math comparison for a 5-person team:
- ChatGPT Team: $25/seat × 5 = **$125/month**
- Linear + Notion + Slack combined: ~$25/seat × 5 = **$125/month**
- **Tangerine Cloud: $80/month flat** ← still cheaper than either, *and* it covers the cross-AI alignment piece those tools don't

For a 30-person team, you save 80% vs ChatGPT Team. For 100-person, 95%. Self-host is still $0.

### How the shared DeepSeek key works

Cloud teams share **one DeepSeek API key** that we manage:
- ~100M tokens included monthly (covers ~30 people of normal co-thinker + atom edits + heartbeat)
- Above that → credit packs ($5 per 10M tokens, no markup tricks; DeepSeek raw is ~$2.7/10M)
- **You see the meter live** in Settings → Billing. No "surprise bill at end of month."
- If you'd rather use your own DeepSeek key (or your own LLM), Self-host is $0 forever.

### Three promises

1. **No per-seat trap.** Grow your team — your base bill doesn't grow.
2. **No paywall pivot.** Self-host stays open-source forever. If we ever raise prices, you have a fork in your back pocket.
3. **Profit in public.** Our ARR + cost dashboard goes live with v2.0. You'll see real numbers per tier, including DeepSeek margin.

### Why charge at all if it's open-source?

Two answers:

- **Time** — Cloud customers don't want to set up DeepSeek API keys, host an MCP server, manage SSL, run backups, patch security holes. $80/month buys their engineer's time back.
- **AGPL gate** — If you redistribute modified Tangerine in a closed-source product, AGPL requires you to open-source your modifications. Most enterprises can't. They buy a commercial license to keep their changes private. That funds the OSS for the rest of us.

See [BUSINESS_MODEL_SPEC.md](./BUSINESS_MODEL_SPEC.md) for the full economic breakdown.

---

## Architecture

Tauri 2 desktop app (Rust backend + React frontend), file-based memory in your home dir, optional MCP server for AI tool integration.

```
~/.tangerine-memory/                  Tauri app                MCP server (Node)
├── team/                             ├── React UI             ├── 7 MCP tools (sources/sinks)
│   ├── co-thinker.md  ◄──heartbeat───┤  Zustand store         │
│   ├── decisions/                    │  i18next (en/zh)        │
│   └── timeline/                     ├── Tauri commands        │
└── personal/                         │  185 typed              ├── Sampling bridge
    └── <user>/                       ├── ws server             │  /sampler ws
        ├── threads/                  │  127.0.0.1:7780  ◄──────┤  reverse-call to host LLM
        └── tools/                    └── faster-whisper        │
                                          (local transcription)
```

- **Sources**: Discord (live), GitHub, Linear, Slack, Calendar, RSS / Podcast / YouTube / Article (hand-rolled parsers)
- **Sinks**: MCP server (7 tools), browser extension (smart inject on ChatGPT/Claude.ai/Gemini), local file write
- **8 personal agents**: parsers for Cursor / Claude Code / Codex / Windsurf / Devin / Replit / Apple Intelligence / MS Copilot

---

## License

**Currently effective**: [Apache-2.0](PRIOR-LICENSE-APACHE-2.0.txt). Copyright 2026 Tangerine Intelligence Inc.

**Transition draft (pending CEO + legal counsel ratification)**: [AGPL v3 + Dual Commercial](LICENSE). See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for commercial terms.

The license flip will be announced when ratification completes. Until then, the codebase is governed by Apache-2.0.

---

## Status (v1.9.1)

| What | State |
|---|---|
| Tests | 546 Rust + 407 frontend + 8 Playwright + 92 MCP vitest = 1053+ tests pass |
| MCP sampling protocol | Real, end-to-end |
| Welcome tour | 4-card 30-sec onboarding |
| 中文 i18n | 287 strings × 2 locales (en/zh 1:1) |
| Cross-vendor parsers | 1/8 real-files-validated (Claude Code), 7/8 wired-and-tested |
| Public release | v1.8.1 (v1.9.1 in flight) |

See [V1_9_ACCEPTANCE.md](./V1_9_ACCEPTANCE.md) for per-phase quality gates.

---

## Docs

- [SUGGESTION_ENGINE_SPEC.md](./SUGGESTION_ENGINE_SPEC.md) — 6 anti-Clippy disciplines + 4 visual tiers + 7 templates
- [V2_0_SPEC.md](./V2_0_SPEC.md) — visualization-first (graphs, lineage, social)
- [V2_5_SPEC.md](./V2_5_SPEC.md) — decision review + paywall
- [V3_0_SPEC.md](./V3_0_SPEC.md) — personal agents + external world
- [V3_5_SPEC.md](./V3_5_SPEC.md) — marketplace + enterprise
- [BUSINESS_MODEL_SPEC.md](./BUSINESS_MODEL_SPEC.md) — anti-SaaS economics
- [COMPETITIVE_ADVANTAGE.md](./COMPETITIVE_ADVANTAGE.md) — execution-leader positioning vs concept-creators
- [DATA_MODEL_SPEC.md](./DATA_MODEL_SPEC.md) — atom schemas
- [API_SURFACE_SPEC.md](./API_SURFACE_SPEC.md) — Tauri command catalog
- [VISUAL_DESIGN_SPEC.md](./VISUAL_DESIGN_SPEC.md) — design tokens
- [OBSERVABILITY_SPEC.md](./OBSERVABILITY_SPEC.md) — error/perf/i18n/SOC2

---

## Owner

Daizhe Zou — daizhe@berkeley.edu. Tangerine Intelligence Inc. (Delaware C-Corp). Best-effort response on issues.
