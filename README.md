<p align="center">
  <img src="docs/assets/tangerine-logo.png" alt="Tangerine" width="96" />
</p>

<h1 align="center">Tangerine</h1>

<p align="center"><strong>Align every AI tool on your team with your team's human workflow information.</strong></p>

<p align="center">Your team uses Cursor, Claude, ChatGPT — but each AI sees a different slice of what your team's actually doing. We align them all with one source of team workflow info. So your AIs stop giving different answers.</p>

<p align="center">
  <a href="https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/latest"><img src="https://img.shields.io/github/v/release/Tangerine-Teams-Intelligence/tangerine-teams-app?include_prereleases&label=download" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/tangerine-mcp"><img src="https://img.shields.io/npm/v/tangerine-mcp?label=tangerine-mcp" alt="tangerine-mcp on npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Win%20%C2%B7%20Mac%20%C2%B7%20Linux-lightgrey" alt="Platforms" />
</p>

---

## Try in 30 seconds

The MCP server ships with a sample team memory baked in. Works on Mac / Windows / Linux, no Tangerine app needed.

**1. Add this block to your AI tool's MCP config:**

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tangerine-demo": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp", "--demo"]
    }
  }
}
```

Claude Code (`~/.config/claude/config.json` on macOS/Linux, `%APPDATA%\Claude\config.json` on Windows): same JSON block.

**2. Restart your AI tool.**

**3. Ask it:**

- *"what's our team's pricing?"*
- *"what did we decide about postgres vs mongo?"*
- *"who was in the roadmap sync meeting?"*

Your AI calls the new `query_team_memory` tool and returns answers from a sample team memory bundled in the npm package. Drop in your own team memory by pointing `--root /path/to/your/memory` at any directory of markdown files, or install the desktop app below to capture meetings automatically.

> Don't see the tool? Make sure you actually restarted your AI client — MCP tools register on startup. Confirm `npx tangerine-mcp@latest --version` prints `0.2.0` first.

---

## Full install (Windows)

[**Download `Tangerine.AI.Teams_1.6.0-beta.1_x64-setup.exe`**](https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/latest) → right-click → Properties → Unblock → run → 5-step wizard.

First-run downloads the local Whisper model (~244 MB) and seeds 3 sample memory files so the Memory browser isn't empty. ~15 minutes from download to first recorded meeting. Full walkthrough in [SETUP.md](SETUP.md).

Requires Windows 10/11, Node 20+, Git, and a Claude Code subscription (the observer/synthesizer runs against your `claude` CLI). macOS and Linux installers land after v1.6.

## Browser extension (Chrome / Edge)

[Download `tangerine-ext-0.1.0.zip`](https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/releases/latest) → unzip → `chrome://extensions` → enable Developer mode → Load unpacked. The 🍊 button appears in ChatGPT / Claude.ai / Gemini chat boxes. Web Store listing pending review.

---

## What it does

We're sometimes called the team's Auto Chief of Staff — same idea, this is what it means specifically: Tangerine listens in every corner of your team's comms (meetings, threads, PRs, tickets) and structures what happened into a markdown memory layer in your own repo. The AI tools you already pay for (Claude, ChatGPT, Cursor, Claude Code) read that memory through Sinks (browser extension, MCP server), so every human and every AI tool on the team operates from the same up-to-date context.

North star: **same-screen rate** — the share of your team (and their AI tools) that's working from current shared context, not stale snapshots.

Five verbs: **Capture · Memory · Search · Inject · Writeback**.

---

## The problem

- You finish a meeting, open Cursor, and re-explain to your AI what was just decided. Every. Single. Time.
- Knowledge sits in 7 silos: Discord, Slack, Notion, Linear, GitHub, Loom, your head. Nothing reconciles them.
- Your AI tools have memory of *you*, not your *team*. They miss the decision your cofounder shipped 20 minutes ago.

## The solution

- **Capture in every corner.** Meetings, voice notes, PRs, tickets, threads — one capture layer.
- **Structured markdown memory.** Decisions, people, projects, threads, glossary. Lives in your git repo. Provenance lines back to the transcript that produced each fact.
- **Fed to the AI you already pay for.** Browser extension drops a 🍊 button into ChatGPT / Claude.ai. MCP server gives Claude Code / Cursor a `query_team_memory()` tool. No new model bill. No vendor lock.

---

## Honest roadmap

| Version | Status | What lands |
|---|---|---|
| **v1.5** | shipping | Discord meetings → memory layer · Memory browser · Cmd+K search · dark mode |
| **v1.6** | beta (now) | Browser extension (Chrome / Edge / Safari) · MCP server (`npx tangerine-mcp`) · Linear source · daily brief · alignment dashboard |
| **v1.7** | planned | Voice notes · GitHub PRs source · pre-meeting brief · writeback approval flow |
| **v1.8** | planned | Slack source · Notion source |
| **v1.9** | planned | Cal.com source · Loom source |

We don't ship roadmaps we don't intend to build. If a version slips, this table changes.

---

## Architecture

```
                Sources                 Memory layer              Sinks
              ┌───────────┐           ┌──────────────┐         ┌──────────────────┐
   Discord ──▶│           │           │              │────────▶│ Browser ext (🍊)  │
   Voice    ──▶│           │           │  meetings/  │         │  ChatGPT / Claude│
   GitHub PR ─▶│  capture  │ ────────▶│  decisions/  │────────▶│ MCP server        │
   Linear    ─▶│           │           │  people/    │         │  Cursor / Claude  │
   Slack     ─▶│           │           │  projects/  │         │   Code            │
   Notion    ─▶│           │           │  glossary/  │────────▶│ Daily brief       │
   Cal/Loom  ─▶└───────────┘           └──────────────┘         └──────────────────┘
                                              │
                                              ▼
                                  user's git repo (markdown)
                                  truth lives here, not in our cloud
```

File-based, no server in the critical path. Tangerine cloud is an optional mirror for cross-device sync.

---

## Why open source

Apache-2.0. Vendor-less data — your memory is markdown in *your* git repo, not our database. Your AI subscription, your inference. We sell the integration shell and cloud sync for teams that want it; the capture pipeline is yours to fork. If we get acquired, vanish, or pivot, your team memory keeps working.

---

## Pricing — Vercel-style open core

🆓 **OSS forever — Apache-2.0**
Self-host the entire stack: desktop app, MCP server, browser ext, source connectors. No team-size limit. No commercial use restriction. Always free. You bring your own GitHub repo for memory storage + your own Claude/Cursor/ChatGPT subscription for AI inference.

☁ **Tangerine Cloud — ~$10/seat/month** (3 seats free, like Vercel Hobby)
Team memory hosted by us (no git setup needed). AI daily brief generation (we run the LLM, included). Cross-device sync (mobile brief notifications, calendar integration). 6 source integrations OAuth managed (no Linear/Slack app registration). Coming Q3 2026.

🏢 **Enterprise — Custom (~$5-15K/year)**
SSO, audit log, SOC2 path. Dedicated support + monthly sync. Self-host with support contract. Coming Q4 2026.

Why this model: Tangerine is an infrastructure layer (like a CDN), not a workspace. Vercel runs the same play — Next.js free, Hosted $20/seat, estimated $200M ARR / $3.25B valuation. We copy: tangerine-teams-app free, Tangerine Cloud $10/seat.

---

## How it differs

| | Tangerine | Granola / Otter | Mem0 / Hermes / Letta | Notion AI |
|---|---|---|---|---|
| Memory subject | The **team** | One human's notes | One **agent**'s context | One workspace's pages |
| Output | Markdown in your git repo | Hosted notes page | Vector store API | Notion DB |
| Reads through | Browser ext + MCP into your existing AI | The notes app itself | Your own agent code | Notion AI only |

Hermes / Mem0 / Letta are agent memory frameworks — they make *one agent* smarter over time. Tangerine is *team* memory — it makes *every human and every AI tool on the team* operate from the same context. Different layer of the stack. Run both.

---

## Repo layout

```
mcp-server/      # tangerine-mcp npm package — query_team_memory MCP tool
browser-ext/     # Chrome / Edge / Safari extension — 🍊 button in chat boxes
app/             # Tangerine desktop app (Tauri + React + TypeScript) — Windows installer source
bot/             # Discord meeting capture bot
src/             # Python observer/synthesizer — runs against your local claude CLI
docs/, tests/    # Documentation, end-to-end tests
```

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, commit format, and the CLA (required for non-trivial contributions — Apache-2.0 + DCO).

Issues, bug reports, and feature requests go in [GitHub Issues](https://github.com/Tangerine-Teams-Intelligence/tangerine-teams-app/issues). Security disclosures: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Tangerine Intelligence Inc.

## Owner

Daizhe Zou — daizhe@berkeley.edu. Issue response: best-effort, side project. For commercial / cloud inquiries: hello@tangerineintelligence.ai.