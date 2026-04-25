# Tangerine Meeting Assistant

> Your meeting → your team's AI context, automatically.

[![Latest Release](https://img.shields.io/github/v/release/Tangerine-Intelligence/tangerine-meeting-live?include_prereleases)](https://github.com/Tangerine-Intelligence/tangerine-meeting-live/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A 45-minute meeting produces three decisions, two new facts, one action plan. Then the CEO opens Claude Code and re-types it all from memory. TMA closes that loop: decisions land in `CLAUDE.md`, `knowledge/`, `session-state.md` as a reviewed diff, not a Notion page.

**Status**: v1.5.0-beta, Apache-2.0. See [PLAN.md](PLAN.md) for roadmap, [INTERFACES.md](INTERFACES.md) for the full spec, [SETUP.md](SETUP.md) to install.

---

## Two ways to use TMA

- **Desktop app (recommended)**: [Download Tangerine AI Teams Setup for Windows](https://github.com/Tangerine-Intelligence/tangerine-meeting-live/releases/latest) → install → sign in → install the Meeting skill → run your first meeting. Requires Node 20+, Git, and a Claude Code subscription. Whisper transcription runs locally (bundled `faster-whisper`); first run downloads ~244 MB to your machine. OpenAI Whisper remains as an opt-in advanced toggle if you want max accuracy or have a weak CPU.
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

[Apache-2.0](LICENSE). Copyright 2026 Tangerine Intelligence Inc.

## Owner

Daizhe Zou — daizhe@berkeley.edu. Side project. Best-effort response on issues.
