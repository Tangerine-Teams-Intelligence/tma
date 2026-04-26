<p align="center">
  <img src="docs/assets/tangerine-logo.png" alt="Tangerine" width="96" />
</p>

<h1 align="center">Tangerine</h1>

<p align="center"><strong>Your AI-native team's Chief of Staff.</strong></p>

<p align="center">Captures every meeting, decision, PR, and ticket. Briefs your team. Briefs their AI. Keeps everyone — and every AI tool — on the same page.</p>

<p align="center">
  <a href="https://github.com/Tangerine-Teams-Intelligence/tma/releases/latest"><img src="https://img.shields.io/github/v/release/Tangerine-Teams-Intelligence/tma?include_prereleases&label=v1.5.6-beta" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="Windows" />
</p>

Tangerine is the auto Chief of Staff for AI-native teams. It listens in every corner of your team's comms — meetings, threads, PRs, tickets — and structures what happened into a markdown memory layer in your own repo. The AI tools you already pay for (Claude, ChatGPT, Cursor, Claude Code) read that memory through Sinks (browser extension, MCP server) so every human and every agent on the team works from the same up-to-date context.

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
| **v1.6** | next | Browser extension (Chrome / Edge / Safari) · MCP server (`npx tangerine-mcp`) · Linear source · daily brief · alignment dashboard |
| **v1.7** | planned | Voice notes · GitHub PRs source · pre-meeting brief · writeback approval flow |
| **v1.8** | planned | Slack source · Notion source |
| **v1.9** | planned | Cal.com source · Loom source |

We don't ship roadmaps we don't intend to build. If a version slips, this table changes.

---

## Quick start

Three commands from zero:

```powershell
# 1. Download the Windows installer (~310 MB)
Invoke-WebRequest "https://github.com/Tangerine-Teams-Intelligence/tma/releases/latest/download/Tangerine-Setup.exe" -OutFile "Tangerine-Setup.exe"

# 2. Install (per-user, no admin)
.\Tangerine-Setup.exe

# 3. Launch Tangerine → click "Set up Discord" → follow the in-app wizard
```

First-run downloads the local Whisper model (~244 MB) and seeds 3 sample memory files so the Memory browser isn't empty. ~15 minutes from download to first recorded meeting. Full walkthrough in [SETUP.md](SETUP.md).

Requires Windows 10/11, Node 20+, Git, and a Claude Code subscription (the observer/synthesizer runs against your `claude` CLI). macOS and Linux installers land after v1.6.

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

## Pricing

| Tier | Price | What you get |
|---|---|---|
| **OSS / self-host** | Free | Capture pipeline, Memory browser, MCP server, Browser extension, Discord source. You run it. |
| **Cloud** | $20/seat/mo, 3-seat floor ($60/mo) | Cross-device sync, hosted Sinks, all 3rd-party Sources, daily brief delivery, support. Annual 20% off. |

Cloud lands with v1.6. Annual contracts available at GA.

---

## How it differs

| | Tangerine | Granola / Otter | Mem0 / Hermes / Letta | Notion AI |
|---|---|---|---|---|
| Memory subject | The **team** | One human's notes | One **agent**'s context | One workspace's pages |
| Output | Markdown in your git repo | Hosted notes page | Vector store API | Notion DB |
| Reads through | Browser ext + MCP into your existing AI | The notes app itself | Your own agent code | Notion AI only |

Hermes / Mem0 / Letta are agent memory frameworks — they make *one agent* smarter over time. Tangerine is *team* memory — it makes *every human and every AI tool on the team* operate from the same context. Different layer of the stack. Run both.

---

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, commit format, and the CLA (required for non-trivial contributions — Apache-2.0 + DCO).

Issues, bug reports, and feature requests go in [GitHub Issues](https://github.com/Tangerine-Teams-Intelligence/tma/issues). Security disclosures: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Tangerine Intelligence Inc.

## Owner

Daizhe Zou — daizhe@berkeley.edu. Issue response: best-effort, side project. For commercial / cloud inquiries: hello@tangerineintelligence.ai.
