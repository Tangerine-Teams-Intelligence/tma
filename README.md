# Tangerine Meeting Assistant

> Your meeting → your team's AI context, automatically.

Every other meeting tool produces notes for humans. We produce **context for AI agents**. When your team meets, decisions and facts flow directly into your Claude Code `CLAUDE.md`, your `knowledge/` repo, your `session-state.md` — not into a Notion page nobody reads.

**Status**: v1 in development. See [PLAN.md](PLAN.md) for the full spec and roadmap.

---

## The problem

Your team just had a 45-minute meeting. Three people argued through a decision, agreed on an action plan, and identified two new constraints. Now the CEO opens his Claude Code session to act on it — and has to re-explain everything from memory. Information loss at every step:

- Human memory → voice → AI: lossy
- AI summary → human → AI: double-lossy
- Next week the team forgets who decided what, why

We fix this by treating your team's AI memory as the real destination, not the recap email.

## How it works

```
  Pre-meeting             Meeting                 Post-meeting
  ───────────             ───────                 ────────────
  tmi prep                tmi start                tmi wrap
  │                       │                        │
  Each member             Discord bot joins        Observer synthesizes
  captures intent         voice channel,           transcript + intents
  (structured prompt)     streams to Whisper       + ground truth
  │                       │                        │
  intents/*.md            transcript.md            summary.md +
                                                   knowledge-diff.md
                                                   │
                                                   tmi review → tmi apply
                                                   │
                                                   Target repo's
                                                   CLAUDE.md / knowledge/
                                                   gets updated
```

Three moments where we differ from Granola / Otter / Zoom AI Companion:

1. **Before**: we capture each member's intent privately and structurally, so the post-meeting synthesis can reason about *who wanted what and whether they got it*.
2. **During**: the AI observer is **silent by default**. It's not a note-taker, not a cheerleader. It flags only contradictions with your ground truth or agenda drift.
3. **After**: the output isn't a summary page — it's a **diff against your team's AI memory**, reviewed like a code PR, committed into your repos.

## v1 Scope

| | v1 | Later |
|---|---|---|
| Input | Discord voice | Zoom, Lark, Meet, Teams |
| Output | Claude Code (CLAUDE.md, knowledge/, session-state.md) | Cursor, Aider, Notion, Linear |
| UI | CLI | Web UI (v2), desktop app (v2.5) |
| Users | Tangerine team (3 people) | Open-source / paid (v3+) |

See [PLAN.md](PLAN.md) for the full roadmap, architecture, data model, and milestone breakdown.

## Why this isn't Granola / Otter

| | Tangerine Meeting Assistant | Granola / Otter / Zoom |
|---|---|---|
| Primary consumer | AI agent in a different session | Human reading later |
| Output format | Diff against knowledge files | Notes page |
| Pre-meeting | Structured intent capture per member | Nothing |
| During | Silent observer, flags only | Live note-taker |
| Moat | Opinionated output adapters per AI tool | Prettier summary |

They're not competitors — they're complements. You can run Granola for human-readable meeting notes and TMA for AI-readable context. They target different people.

## Getting started

v1 is not yet installable. This repo currently contains:

- [PLAN.md](PLAN.md) — the complete v1 spec (read this first)
- [legacy/](legacy/) — the original WASAPI-based proof of concept (deprecated, preserved for reference)

Week 1 implementation starts after the plan is signed off.

## License

TBD. Apache-2.0 if the open-source distribution path is taken. See [PLAN.md §10](PLAN.md).

## Owner

Daizhe Zou — Tangerine Intelligence CEO
