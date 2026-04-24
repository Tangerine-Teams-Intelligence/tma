# Tangerine Meeting Assistant — v1 Plan

**Status**: v1 spec, locked 2026-04-24
**Scope**: Discord input → Claude Code output, CLI only, Tangerine team dogfood
**Owner**: Daizhe Zou
**Timeline**: 4 weeks to shippable v1

---

## 1. Positioning

**One-liner**: Your meeting → your team's AI context, automatically.

**The wedge**: every other meeting tool produces notes for humans to read. We produce **context for AI agents to consume**. We write directly into your team's AI memory (`CLAUDE.md`, `.cursorrules`, knowledge repos) — not just into a Notion page that nobody reads.

**Why this is defensible**:
- Incumbents (Granola, Otter, Zoom AI Companion, Fireflies) sell to humans. Their product decisions optimize for "pretty summary you'll read." They won't pivot to "invisible context injection for LLM agents" — wrong customer.
- The IP is in the output adapters — opinionated modules that understand how each AI tool remembers (Claude Code's knowledge/, Cursor's rules, Aider's conventions). Generic markdown export is not enough.
- Teams that use AI dev tools ($10-20/month tier) are the ideal customer: they pay for tools, they hate context re-entry, they understand the problem immediately.

**What it's not**: it's not a notes app, not a transcription service, not a CRM integration. Audio capture and summary generation are commodities — we use them, we don't compete on them.

---

## 2. v1 Scope (Explicit Non-Goals)

### In scope
- **Input**: Discord voice channel only
- **Output**: Claude Code memory system (`CLAUDE.md`, `knowledge/`, `session-state.md`)
- **Users**: Tangerine internal team (3 members: DZ / Hongyu / Advisor)
- **Form**: CLI, invoked from terminal
- **Storage**: local git repo (`tangerine-meetings`), no hosting

### Out of scope (explicit non-goals for v1)
- ❌ WASAPI / system audio loopback (Discord bot captures voice directly)
- ❌ Local Whisper GPU deployment (use Whisper API — commodity, cheap)
- ❌ Zoom / Lark / Google Meet / Teams input (v1.1, v1.2, ...)
- ❌ Cursor / Aider / OpenAI Projects output (v1.1+)
- ❌ Web UI, desktop app, mobile (all deferred to v2)
- ❌ Multi-team, auth, hosting, SaaS (deferred to v3 if ever)
- ❌ Marketing site, landing page, waitlist

---

## 3. Architecture

Three layers, thin at both ends, opinionated in the middle.

```
┌──────────────────────────────────────────────────────┐
│                    INPUT LAYER                       │
│  Discord bot → Whisper API → transcript.md           │
│  (v1.1+: Zoom, Lark, Meet, Teams, manual upload)     │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│                    CORE ENGINE                       │
│  1. Pre-meeting intent capture (structured prompt)   │
│  2. Live observer (silent/active modes)              │
│  3. Post-meeting synthesis (summary + diff)          │
│  → local git repo as source of truth                 │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│                   OUTPUT LAYER                       │
│  Claude Code adapter: writes to CLAUDE.md,           │
│  knowledge/, session-state.md in target repo         │
│  (v1.1+: Cursor, Aider, Notion, Linear, Obsidian)    │
└──────────────────────────────────────────────────────┘
```

**Design principles**:
1. **Git as database**. Every artifact is a file in a git repo. Full audit trail, no custom DB, works offline, team sync via `git pull`.
2. **Human-editable everywhere**. intents, summaries, diffs are all markdown. User can edit any step.
3. **Diff-review, not auto-merge**. Knowledge base changes require explicit approval before write.
4. **Traceable**. Every rule in the target knowledge base can be traced back to the originating meeting and transcript line.

---

## 4. Data Model

### 4.1 The meeting directory

```
meetings/
  2026-04-24-david-sync/
    meeting.yaml              # metadata
    intents/
      daizhe.md               # pre-meeting intent from DZ
      hongyu.md
      advisor.md
    transcript.md             # live-written during meeting
    observations.md           # observer's silent flags (optional)
    summary.md                # post-meeting structured summary
    knowledge-diff.md         # proposed knowledge base changes
    status.yaml               # workflow state tracking
```

### 4.2 `meeting.yaml`

```yaml
id: 2026-04-24-david-sync
title: "David sync — meeting product direction"
scheduled_at: 2026-04-24T19:00:00+08:00
participants:
  - name: Daizhe Zou
    alias: daizhe
    discord_id: "<snowflake>"
  - name: Hongyu Xu
    alias: hongyu
    discord_id: "<snowflake>"
target_knowledge_repo: "C:/Users/daizhe zo/Desktop/Tangerine Intelligence"
```

### 4.3 `intents/{alias}.md`

```markdown
---
author: daizhe
created_at: 2026-04-24T18:30:00+08:00
locked: true
---

## Topics

### Topic 1: Meeting Assistant v1 scope lock
- **Type**: decision (A/B choice)
- **Goal**: decide whether to ship Discord-only or add Zoom at v1
- **Expected disagreement**: Hongyu may push for Zoom
- **My current stance**: Discord-only v1, Zoom at v1.1

### Topic 2: Weekly dogfood cadence
- **Type**: sync
- **Goal**: confirm every Monday standup runs through TMA
- **Expected disagreement**: none
- **My current stance**: start next Monday

## Knowledge writeback expectations
- Decision on v1 scope → `session-state.md`
- Weekly cadence rule → `CLAUDE.md`
```

### 4.4 `status.yaml`

```yaml
state: prepped | live | wrapped | reviewed | merged
intents_ready: [daizhe, hongyu]
intents_missing: [advisor]
wrap_completed_at: 2026-04-24T20:15:00+08:00
merged_commit: abc123...
```

---

## 5. Component Specs

### 5.1 CLI: `tmi`

Python-based, installed via pip. Config at `~/.tmi/config.yaml`.

```
tmi init                              # scaffold ~/.tmi/config.yaml + link to meetings repo
tmi new <title>                       # creates new meeting dir with auto-generated id
tmi prep <meeting-id>                 # interactive intent capture (invokes Claude subprocess)
tmi start <meeting-id>                # launches Discord bot + observer
tmi observe <meeting-id>              # observer only (if transcript comes from elsewhere)
tmi wrap <meeting-id>                 # synthesize summary.md + knowledge-diff.md
tmi review <meeting-id>               # interactive diff approval UI (terminal)
tmi apply <meeting-id>                # writes approved diffs to target knowledge repo
tmi list [--status=...]               # list meetings by state
tmi status <meeting-id>               # show workflow state
```

### 5.2 Discord Bot

**Runtime**: Node.js, `discord.js` + `@discordjs/voice`.
**Why Node.js not Python**: Python Discord voice stack is unmaintained. `discord.js` voice is actively maintained and well-documented.

**Behavior**:
- Bot account invited to the Tangerine Discord server
- Command `/tmi-join` triggers it to join the caller's current voice channel
- Captures per-user Opus audio streams
- Each stream → Whisper API (`whisper-1` model) in ~10-second chunks
- Writes labeled lines to `transcript.md`:
  ```
  [19:02:14] DZ: 所以我们先只做 Discord 对吧？
  [19:02:18] Hongyu: 对，Zoom 等 v1.1。
  ```
- Speaker label comes from `discord_id → alias` mapping in `meeting.yaml`
- Command `/tmi-leave` stops recording, triggers optional auto-wrap

**Auth**: Discord bot token in `~/.tmi/config.yaml` (gitignored).

**Cost**: Whisper API = $0.006/min. 1-hour meeting = ~$0.36. Trivial.

### 5.3 Observer

One Python module, three modes controlled by CLAUDE.md prompt variant.

#### Prep mode
- Triggered by `tmi prep <meeting-id>`
- Spawns `claude` subprocess with `--append-system-prompt` pointing to `prompts/prep.md`
- Prep prompt: structured interrogation (topic → type → goal → disagreement → writeback expectation)
- Session ends when user types `done` or hits a turn limit
- Writes `intents/{alias}.md`, locks it, commits

#### Observe mode
- Triggered by `tmi start <meeting-id>` (or standalone `tmi observe`)
- Long-running `claude` subprocess with `prompts/observe.md`
- Polls `transcript.md` every 30s, reads last 2 minutes
- **Silent by default**. Only writes to `observations.md` when:
  1. Content contradicts team CLAUDE.md / knowledge/
  2. A pre-meeting intent topic hasn't been addressed in 10+ minutes of its expected slot
  3. User explicitly queries via `tmi ask "..."` from another terminal
- Passive/Active mode toggle: Passive = file-only; Active = also push notification (v1.1: Discord DM)

#### Wrap mode
- Triggered by `tmi wrap <meeting-id>`
- One-shot `claude` invocation with `prompts/wrap.md`
- Inputs loaded: all `intents/*.md`, full `transcript.md`, `observations.md`, target knowledge repo's `CLAUDE.md` + `knowledge/`
- Outputs: `summary.md` (structured by topic, with intent/outcome/stance-change sections) + `knowledge-diff.md` (proposed changes in diff format)
- Commits both files

### 5.4 Claude Code Output Adapter

**Config** (`~/.tmi/config.yaml`):
```yaml
output_adapters:
  - type: claude_code
    name: tangerine-main
    target_repo: "C:/Users/daizhe zo/Desktop/Tangerine Intelligence"
    files:
      claude_md: "CLAUDE.md"
      knowledge_dir: "knowledge/"
      session_state: "knowledge/session-state.md"
    commit_author: "Tangerine Meeting Assistant <tma@tangerine.local>"
```

**Responsibilities**:
1. **Read** the target repo's current knowledge structure. Feed it into wrap prompt as ground truth context.
2. **Generate** diff in a format aware of the target repo's conventions:
   - New decisions → append to `session-state.md` under "最近会议" section
   - New rules → append to `CLAUDE.md` under the appropriate section (绝对不要 / 法律红线 / 部署铁律)
   - New facts → create or append to `knowledge/{topic}.md`
3. **Apply** approved diffs: write files, `git add`, `git commit` in target repo with message `meeting: {title} ({date})`.
4. **Do NOT push**. User pushes manually after review.

### 5.5 Diff format

`knowledge-diff.md` is human-readable markdown, each change block is:

````markdown
### 📝 knowledge/session-state.md

**Action**: append to "最近会议" section
**Reason**: Decision made on v1 scope (David sync, 2026-04-24 Topic 1)
**Transcript refs**: L47, L52, L58

```diff
+ ### 2026-04-24 — David sync
+ - v1 scope 锁定为 Discord input + Claude Code output（Zoom 延至 v1.1）
+ - 决策人: DZ, Hongyu 无异议
+ - Action: @DZ 4/28 前提交 Discord bot 原型
```

---

### 🔧 CLAUDE.md

**Action**: add rule under "部署铁律"
**Reason**: Weekly TMA dogfood commitment
**Transcript refs**: L112

```diff
+ ### 会议纪律
+ - 每周一 standup 必须走 TMA 流程（prep → start → wrap → review）
```
````

`tmi review` parses these blocks and shows them interactively with ✓/✗/edit.

---

## 6. User Flow (End-to-End)

### Pre-meeting (T-1 hour, each member separately)

```bash
# DZ on his laptop
$ tmi prep 2026-04-24-david-sync
[Claude session opens in terminal]
Observer: 这次会议你想讨论的 topic 有哪些？
DZ: 1) v1 scope 锁定 2) 周一 dogfood 节奏
...
[intent locked, committed]

# Hongyu on his laptop — independent, doesn't see DZ's intent
$ tmi prep 2026-04-24-david-sync
...
```

### Meeting start (T-0)

```bash
# One member (DZ) on his laptop, same one that will be in Discord
$ tmi start 2026-04-24-david-sync
[Discord bot joins voice channel]
[Observer starts polling transcript.md]
Status: live · observing silently
Side terminal: tail -f observations.md
```

Everyone talks normally in Discord. Transcript auto-writes. Observer silent unless flags fire.

### Meeting end

```bash
$ tmi wrap 2026-04-24-david-sync
[Claude reads all intents + transcript + ground truth]
[Writes summary.md, knowledge-diff.md]
Status: wrapped · ready for review
```

### Review

```bash
$ tmi review 2026-04-24-david-sync
[Interactive terminal UI, one diff block at a time]
Block 1/4: session-state.md — append v1 scope decision
  [a]pprove  [r]eject  [e]dit  [s]kip
> a
...
Status: reviewed · 3 approved, 1 rejected

$ tmi apply 2026-04-24-david-sync
[Writes to target repo, creates commit]
Commit: meeting: david-sync (2026-04-24) @ target repo
Status: merged
```

Push to target repo remote is manual (`cd target && git push`) — intentional final safety gate.

---

## 7. Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| CLI | Python 3.11 + Typer | fast dev, rich terminal UI libraries |
| Discord bot | Node.js 20 + discord.js v14 | only maintained Discord voice stack |
| Transcription | OpenAI Whisper API (`whisper-1`) | $0.006/min, no ops, fine quality |
| Observer LLM | `claude` CLI subprocess (headless mode) | reuse Claude Code subscription, no API key for LLM |
| Storage | local git repo | diff-native, audit trail, no DB |
| Target integration | file I/O + `git` via `subprocess` | no lock-in, works on any repo |
| Config | YAML at `~/.tmi/config.yaml` | human-editable |

---

## 8. Milestones

### Week 1 — Scaffolding (5 dev days)
- [ ] `tmi` CLI skeleton (Typer, command stubs)
- [ ] Meeting directory scaffolding (`tmi new`, `tmi init`)
- [ ] `~/.tmi/config.yaml` load/save
- [ ] Claude Code output adapter: config validation + target repo detection
- [ ] `tmi prep` end-to-end with one member (headless Claude subprocess + prep prompt + intent write)
- [ ] **Demo**: DZ prep'd one test meeting, intent file in repo

### Week 2 — Discord input (5 dev days)
- [ ] Discord bot skeleton (discord.js, voice intents, bot account registered on Tangerine server)
- [ ] `/tmi-join` + `/tmi-leave` slash commands
- [ ] Per-user audio capture → Whisper API streaming
- [ ] transcript.md live writes with speaker labels
- [ ] `discord_id → alias` mapping in meeting.yaml
- [ ] **Demo**: 5-minute test call between DZ and Hongyu, transcript.md populated

### Week 3 — Observer + wrap (5 dev days)
- [ ] Observe mode: polling loop, flag conditions, observations.md writes
- [ ] Wrap mode: full synthesis prompt, summary.md format, knowledge-diff.md format
- [ ] `tmi review` interactive terminal UI (approve/reject/edit each diff block)
- [ ] `tmi apply` writes to target repo + creates commit
- [ ] **Demo**: first real meeting (DZ + Hongyu) fully end-to-end, diffs merged into Tangerine Intelligence repo

### Week 4 — Polish + docs (5 dev days)
- [ ] Error recovery (bot disconnect, API timeout, partial transcript)
- [ ] Crash recovery (wrap from partial state)
- [ ] README rewrite + setup guide + screencast demo
- [ ] `tmi --help` for every command
- [ ] Installation: `pip install tangerine-meeting-assistant` (or direct from git)
- [ ] **Ship**: v1.0 tag, repo public-ready, announce to Tangerine team as standard tool

**Total**: 4 weeks, 1 engineer (or DZ + agents).

---

## 9. Open Questions (Need Decision Before Week 1 Starts)

1. **Intent input verbosity floor**: minimum 1 topic + goal-type, or richer? (My default: minimum = topic title + goal type. Everything else optional.)
2. **Observer flag delivery in Passive mode**: file-only, or optional Discord DM to host? (My default: file-only for v1, Discord DM for v1.1.)
3. **Auto-wrap on `/tmi-leave`**: trigger `tmi wrap` automatically when bot leaves, or require explicit `tmi wrap` call? (My default: prompt user "wrap now? [y/n]".)
4. **Multi-intent conflict detection**: if two members' intents have contradicting goals, should observer flag pre-meeting? (My default: yes, flag to meeting host — prevents ambush.)
5. **Non-Tangerine member Discord handling**: what if a guest is in the call with no pre-meeting intent? (My default: their audio is transcribed but labeled `GUEST:N`, no intent expected.)

---

## 10. Out of v1, On Roadmap

### v1.1 — more inputs (2 weeks after v1)
- Zoom Marketplace app (post-meeting transcript pull)
- Lark/飞书 Open Platform integration (China team readiness)
- Manual upload (audio file or pasted transcript)

### v1.2 — more outputs (2 weeks after v1.1)
- Cursor adapter (`.cursorrules` + memory)
- Aider adapter (`.aider.conf.yml` + CONVENTIONS.md)
- Notion action-item sync

### v2 — web UI (6-8 weeks, only if dogfood succeeds for 4+ weeks)
- Next.js + shadcn local app
- 5 screens: Team Home, Prep, Live, Review, Knowledge Browser
- Tauri desktop app packaging

### v3 — open to external teams (only if v2 gets organic interest)
- Pricing: $15/seat/month, freemium on 1 output adapter
- Auth, multi-team, optional cloud sync
- **Explicit gate**: only after Tangerine ships iFactory v1 + at least 5 paying factory customers. No GTM investment before that.

---

## 11. Success Criteria for v1

v1 ships successfully if, at the end of week 4, **all of these** are true:

1. Tangerine team runs every Monday standup through TMA for 2 consecutive weeks without falling back to manual notes.
2. Zero information-transmission gaps: no Monday standup results in DZ having to re-explain decisions to his Claude Code session manually.
3. At least 5 approved knowledge-diff merges in the Tangerine Intelligence repo traceable to TMA meetings.
4. Hongyu and Advisor (non-builders) can run `tmi prep` and `tmi review` unassisted.
5. Cost under $20/month in Whisper API fees for the team.

If any of these fail, we fix them before starting v1.1 work.

---

## 12. Repository Structure (Target)

```
tangerine-meeting-live/
├── README.md                      # positioning + quick start
├── PLAN.md                        # this file
├── LICENSE                        # TBD (Apache-2.0 if open source path chosen)
├── pyproject.toml                 # tmi CLI packaging
├── src/
│   └── tmi/
│       ├── __init__.py
│       ├── cli.py                 # Typer commands
│       ├── config.py              # ~/.tmi/config.yaml
│       ├── meeting.py             # directory + metadata handling
│       ├── observer/
│       │   ├── prep.py
│       │   ├── observe.py
│       │   ├── wrap.py
│       │   └── prompts/
│       │       ├── prep.md
│       │       ├── observe.md
│       │       └── wrap.md
│       └── adapters/
│           └── claude_code.py
├── bot/
│   ├── package.json               # Node.js Discord bot
│   ├── src/
│   │   ├── index.ts
│   │   ├── commands/
│   │   │   ├── join.ts
│   │   │   └── leave.ts
│   │   └── transcription/
│   │       └── whisper.ts
├── legacy/                        # old WASAPI code, preserved
│   ├── README.md                  # pointer to new structure
│   ├── transcribe.py
│   ├── list_devices.py
│   └── requirements.txt
└── docs/
    ├── setup.md
    ├── discord-bot-install.md
    └── architecture.md
```

---

**Next action (from DZ)**: confirm this plan or push back on any section. Once confirmed, week 1 work begins.
