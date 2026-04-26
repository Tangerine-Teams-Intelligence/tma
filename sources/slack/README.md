# `@tangerine/source-slack`

Slack source connector for Tangerine. Watches one or more channels and turns every message, thread reply, channel-create event, and pin into an **atom** in your team-memory tree. The atom format is documented in [`../README.md`](../README.md).

Slack is the #1 fastest-decaying communication channel — chat fades from working memory in hours unless captured. Tangerine pulls every message into the same atom stream as GitHub / Calendar so cross-channel threads stay legible.

## Install

This package is part of the Tangerine monorepo and is not published to npm.

```bash
cd sources/slack
npm install
npm run build
```

The CLI is installed as `tangerine-slack` if you `npm link` from this directory; otherwise invoke `node dist/cli.js`.

## Quick start

### 1. Create a Slack app (CEO does this once per workspace)

Tangerine talks to Slack via a Bot Token. The CEO needs to register an app in your workspace:

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it "Tangerine" (or any internal name) and pick your workspace.
3. Under **OAuth & Permissions**, add the following Bot Token Scopes:
   - `channels:history` — read messages in public channels Tangerine is invited to
   - `groups:history` — read messages in private channels Tangerine is invited to
   - `im:history` — DMs (optional, can omit if you want)
   - `users:read` — resolve `<@Uxxx>` mentions to display names
   - `team:read` — workspace metadata
   - `pins:read` — detect pinned messages
   - `reactions:read` — detect ⭐ reactions
4. Click **Install to Workspace** → authorize.
5. Copy the **Bot User OAuth Token** (starts with `xoxb-…`). Don't share it.
6. Invite the bot to each channel you want Tangerine to watch:
   ```
   /invite @Tangerine
   ```

User Token mode (`xoxp-…`) is also supported via `--mode=user`. User tokens see everything the user sees but don't need explicit channel invites — handy for solo-mode setups.

### 2. Set the token

```bash
tangerine-slack auth set
# (input will be visible) Paste Slack Bot token (xoxb-…) and press enter: <PASTE>
# token saved for tangerine-bot@acme (bot mode)
```

The token is stored in your OS keychain via `keytar` (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). It never lives on disk in plaintext.

For a user token:
```bash
tangerine-slack auth set --mode=user
# (input will be visible) Paste Slack User token (xoxp-…) and press enter: <PASTE>
```

Verify:

```bash
tangerine-slack auth status
# OK — token belongs to tangerine-bot@acme
```

### 3. Add channels to ingest

Find channel ids by running `tangerine-slack channels list --remote` (lists every channel the bot can see):

```bash
tangerine-slack channels list --remote
#   C01ENG  #eng-v1-launch
#   C02WEB  #eng-web
```

Then:

```bash
tangerine-slack channels add C01ENG
tangerine-slack channels add #eng-v1-launch --projects=v1-launch
tangerine-slack channels list
#   C01ENG #eng-v1-launch
#   eng-v1-launch projects=[v1-launch]
```

`--projects` tags every atom from that channel with the given project IDs (in addition to any auto-detected from channel-name prefixes like `eng-` / `proj-`).

### 4. Poll

One-shot:

```bash
tangerine-slack poll
# processed 1 channel(s) — 47 atom(s) seen, 47 new
#   C01ENG (#eng-v1-launch): 47 atoms, 47 written, 0 dup, cursor=1714200000.222222
```

Daemon (polls every `poll_interval_sec`, default 60s):

```bash
tangerine-slack watch
# watching — Ctrl+C to stop
```

`--dry-run` produces atoms in memory but does NOT write to disk:

```bash
tangerine-slack poll --dry-run
# [dry-run] processed 1 channel(s) — 12 atom(s) generated, none written
```

## Atom kinds emitted

| Slack event             | atom.kind | thread id                       |
| ----------------------- | --------- | ------------------------------- |
| message in channel      | `comment` | `slack-<channel>-<thread_ts>`   |
| reply in thread         | `comment` | `slack-<channel>-<thread_ts>`   |
| message with decision verb (`decided`, `agreed`, `let's go with`, …) | `decision` | same |
| pinned message          | `decision` | same                           |
| channel created         | `system`  | `slack-<channel>-channel`       |

## Importance signal

A ⭐ reaction (configurable via `importance_reaction` in `slack.config.json`) bumps the atom's `importance` field to 0.75 (configurable via `importance_boost`). This is part of the Stage 1 AGI hooks (`STAGE1_AGI_HOOKS.md`) — Stage 2 reasoning agents use the field to rank atoms beyond raw recency.

Pinned messages get `importance = 0.85` automatically.

## Cursor and config

State lives in two files inside the memory root:

- `<memory>/.tangerine/sources/slack.config.json` — channel list, poll interval, importance settings
- `<memory>/.tangerine/sources/slack.cursor.json` — per-channel last-seen Slack `ts`
- `<memory>/.tangerine/sources/slack.identity.json` — Slack user id → Tangerine alias map

Delete cursors to replay a channel from scratch. Delete identity entries to remap aliases.

## AGI hooks

Every atom emitted carries the 8 future-proof fields documented in `STAGE1_AGI_HOOKS.md` Hook 1:

```yaml
embedding: null
concepts: []
confidence: 1.0
alternatives: []
source_count: 1
reasoning_notes: null
sentiment: null
importance: null   # or 0.75 for ⭐, 0.85 for pinned
```

Stage 2 reasoning loops mutate these in place — no schema migration needed.
