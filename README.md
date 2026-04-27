# Tangerine

> **Align every AI tool on your team with your team's actual workflow.**
>
> Your team uses Cursor, Claude, ChatGPT — but each AI sees a different slice of what your team's actually doing. We align them all with one source of team workflow. So your AIs stop giving different answers.

[![Latest Release](https://img.shields.io/github/v/release/Tangerine-Intelligence/tangerine-meeting-live?include_prereleases)](https://github.com/Tangerine-Intelligence/tangerine-meeting-live/releases/latest)
[![License: Apache-2.0 (current)](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](PRIOR-LICENSE-APACHE-2.0.txt)
[![License: AGPL v3 + Commercial (transition draft)](https://img.shields.io/badge/license-AGPL_v3_+_Commercial-orange.svg)](LICENSE)

## License — transition in progress (2026-04)

Tangerine is moving from Apache 2.0 to AGPL v3 + Dual Commercial License.
See `LICENSE` (draft AGPL v3 + dual) and `COMMERCIAL-LICENSE.md` (draft
commercial terms). Until ratification announced, codebase is governed
by Apache 2.0 — see `PRIOR-LICENSE-APACHE-2.0.txt`.

We're sometimes called the team's Auto Chief of Staff — same idea, this is what it means specifically: Tangerine listens in every corner of your team's comms (meetings, decisions, threads, code), structures it into team memory in your own dir, and feeds it back to every AI tool you already pay for (Claude Pro, ChatGPT, Cursor, Claude Code) through Sinks (browser extension, MCP server). North star metric: **same-screen rate** — the share of your team (and their AI tools) that's working from the same up-to-date context.

**Status (v1.5.6-beta)**: Sources = Discord (live). Sinks = none yet (browser extension + MCP server land v1.6). See the roadmap below.

### Roadmap

| Version | What lands |
|---|---|
| **v1.5** (now) | Discord source · memory tree UI · dark mode · Cmd+K memory search (stub) |
| **v1.6** | Linear + GitHub sources · browser extension Sink · MCP server Sink · memory fulltext index |
| **v1.7** | Calendar source · /inbox approval flow for write-back · Public API Sink |
| **v1.8** | Slack + Notion sources |
| **v1.9** | Loom + Zoom sources |

---

## Two ways to use Tangerine

- **Desktop app (recommended)**: [Download Tangerine for Windows](https://github.com/Tangerine-Intelligence/tangerine-meeting-live/releases/latest) → install → sign in → set up the Discord source → run your first meeting. Discord is the only source shipping in v1.5; Linear / Slack / Notion / GitHub / Cal / Loom / Zoom land in v1.6+. Requires Node 20+, Git, and a Claude Code subscription. Whisper transcription runs locally (bundled `faster-whisper`); first run downloads ~244 MB to your machine. OpenAI Whisper remains as an opt-in advanced toggle if you want max accuracy or have a weak CPU.
- **CLI**: `pip install tangerine-meeting-assistant` + `npm install` for the bot. See [SETUP.md](SETUP.md).

---

## 60-second demo

```
$ tmi new "David sync"
/Users/dz/tangerine-meetings/meetings/2026-04-24-david-sync

$ tmi prep
intent locked for daizhe -> intents/daizhe.md

$ tmi start
Status  live · meeting=2026-04-24-david-sync
Tail    tail -f .../transcript.md
Flags   tail -f .../observations.md
Stop    tmi wrap 2026-04-24-david-sync

# [meeting happens in Discord. bot transcribes. observer flags drift silently.]

$ tmi wrap
wrapped  summary=summary.md diff_blocks=4

$ tmi review
Block 1/4  ·  knowledge/session-state.md  ·  append
Reason: v1 scope decision
Refs: L47, L52, L58
────────────────────────────────────────────
+ ### 2026-04-24 — David sync
+ - v1 scope 锁定为 Discord + Claude Code
────────────────────────────────────────────
[a]pprove  [r]eject  [e]dit  [s]kip  [q]uit
> a
...
all blocks decided -> state=reviewed

$ tmi apply
applied 3 file(s) commit=4617800
Reminder: cd "<target_repo>" && git push
```

---

## How it differs

| | TMA | Granola / Otter / Zoom AI |
|---|---|---|
| Primary consumer | AI agent in your next session | Human reading later |
| Output | Diff against your knowledge files | Notes page |
| Pre-meeting | Structured per-member intent capture | Nothing |

Not a competitor to Granola — different customer. Run both if you want human notes AND AI context.

## How we make money

Tangerine is open source forever. You can run it on your laptop, fork the repo, name your AI whatever you want, and never pay us anything.

If you want zero-config, use Tangerine Cloud:
- **Bring your own Cursor Pro / Claude Pro** — Tangerine borrows your existing subscriptions, no API keys, no Tangerine cost.
- **Or use Tangerine credits** — backed by DeepSeek V4. Pay per token, not per seat. ~$2-5/team/month for a typical co-thinker.

[Marketplace + Enterprise white-label coming v2.0]

See [BUSINESS_MODEL_SPEC.md](./BUSINESS_MODEL_SPEC.md) for the full breakdown.

## Three differentiators

1. **Vendor-less output.** No hosted dashboard. Output is a git commit to *your* repo. You own the bytes.
2. **Consumer inversion.** Summary is for the LLM you'll talk to tomorrow, not the teammate who missed the call.
3. **Output as diff.** Every change is a reviewable block with transcript line references. No "trust the AI" — approve/reject per block.

## Quick start

Assumes SETUP.md is done (Discord bot created, API keys set, deps installed).

```bash
tmi init                               # one-time, writes ~/.tmi/config.yaml
tmi new "weekly standup"               # creates meeting dir
tmi prep                               # each member, separately
tmi start                              # joins Discord voice
# ... meeting happens ...
tmi wrap && tmi review && tmi apply    # synthesize, approve, commit
```

See [SETUP.md](SETUP.md) for the full walkthrough (Discord bot creation, API keys, first meeting). ~15 minutes from zero.

## Architecture

Three components, file-based IPC, no server.

```
tmi (Python CLI) ──► meetings/<id>/ ◄── bot (Node, Discord + Whisper)
       │
       ├──spawns──► observer (claude CLI subprocess)
       │
       └──applies──► target_repo/CLAUDE.md, knowledge/, session-state.md
```

- **CLI**: Python 3.11 + Typer. Meeting lifecycle, review, apply.
- **Bot**: Node 20 + discord.js v14. Voice capture, Whisper streaming, transcript writes.
- **Observer**: `claude` CLI headless. Prep / observe / wrap via JSON envelopes.
- **Adapter**: pure Python. Reads target repo, parses diff, applies blocks, commits.

Git is the database. Every artifact is a markdown or YAML file in a repo you control.

## Docs

- [SETUP.md](SETUP.md) — install + first meeting in <15 min
- [PLAN.md](PLAN.md) — product spec + 4-week v1 roadmap
- [INTERFACES.md](INTERFACES.md) — locked cross-component contract
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, commit format, PR process
- [SECURITY.md](SECURITY.md) — responsible disclosure

## License

**Currently effective:** [Apache-2.0](PRIOR-LICENSE-APACHE-2.0.txt). Copyright 2026 Tangerine Intelligence Inc.

**Transition draft (pending CEO + legal counsel ratification):** [AGPL v3 + Dual Commercial](LICENSE). See `COMMERCIAL-LICENSE.md` for commercial terms.

## Owner

Daizhe Zou — daizhe@berkeley.edu. Side project. Best-effort response on issues.
