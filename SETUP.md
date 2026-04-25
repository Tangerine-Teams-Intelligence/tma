# SETUP.md — Tangerine Meeting Assistant

Zero-to-first-meeting in ~15 minutes. Follow top to bottom.

If you get stuck, jump to [§7 Troubleshooting](#7-troubleshooting).

---

## 1. Prerequisites

Install these first. Versions matter.

| Tool | Version | Check |
|---|---|---|
| Python | 3.11+ | `python --version` |
| **Node.js** | **20 LTS+ (required for Discord bot subprocess)** | `node --version` |
| git | any recent | `git --version` |
| Claude Code | subscription + `claude` CLI in PATH | `claude --version` |
| OpenAI API key | access to `whisper-1` | see §3 |
| Discord account | with permission to add a bot to your team's server | — |

The `claude` CLI is what powers the observer (prep / observe / wrap modes). TMA spawns it as a subprocess — no API key for Claude.

Node 20+ is required at runtime: we ship the Discord bot as a JavaScript directory bundle and spawn it via your local Node, not via a bundled runtime. Same prerequisite model as Claude Code — we use what you already have, never our own cloud. If you don't have Node, install the LTS from <https://nodejs.org/> and restart the app.

---

## 2. Create the Discord bot

This is the only step with real UI clicking. Budget 5 minutes.

### 2.1 Create the application

1. Go to https://discord.com/developers/applications
2. Click **New Application** (top right).
3. Name it. Suggested pattern: `TMA - <YourTeam>` (e.g. `TMA - Tangerine`).
4. Accept terms, click **Create**.

### 2.2 Get the bot token

1. Left sidebar → **Bot**.
2. Click **Reset Token** → confirm → **Copy**. You see this token once. Save it somewhere safe — this is `DISCORD_BOT_TOKEN`.

### 2.3 Enable the one required intent

Still on the **Bot** page, scroll down to **Privileged Gateway Intents**:

- **Server Members Intent**: ON
- **Message Content Intent**: OFF (we don't need it)
- **Presence Intent**: OFF

`GuildVoiceStates` is a non-privileged intent and needs no toggle — it's implicit in the gateway config.

Click **Save Changes**.

### 2.4 Generate the invite URL

1. Left sidebar → **OAuth2** → **URL Generator**.
2. **Scopes**: check BOTH `bot` AND `applications.commands`. Missing `applications.commands` is the #1 reason slash commands don't show up.
3. **Bot Permissions**: check
   - `Connect`
   - `Speak`
   - `Use Voice Activity`
   - `Send Messages`
4. Copy the URL at the bottom.

### 2.5 Invite the bot

1. Paste the URL into your browser.
2. Pick your team's Discord server.
3. **Authorize**.

### 2.6 Get your Guild ID

You need the ID of the Discord server you just added the bot to.

1. In Discord: **User Settings** (gear icon, bottom left) → **Advanced** → **Developer Mode**: ON.
2. Close settings. Right-click your server's icon in the left rail → **Copy Server ID**.

Save this — it's the `discord.guild_id` config value.

### 2.7 (Optional) Get team members' Discord IDs

With Developer Mode on, right-click each user in your server → **Copy User ID**. You'll map these to aliases in §5.

---

## 3. Get an OpenAI API key (for Whisper)

1. https://platform.openai.com/api-keys → **Create new secret key**. Scope to "All" or minimum `audio.transcriptions:write`.
2. Copy the key. Save as `OPENAI_API_KEY`.

**Cost**: Whisper = $0.006/min. A 1-hour meeting = ~$0.36. The default 10-second chunking means one API call per 10 seconds per active speaker.

---

## 4. Install TMA

```bash
git clone https://github.com/Tangerine-Intelligence/tangerine-meeting-live
cd tangerine-meeting-live

# Python CLI
pip install -e .

# Discord bot
cd bot
npm install
npm run build
cd ..
```

Verify:

```bash
tmi --version
node bot/dist/index.js --help
```

Both should print usage without errors.

---

## 5. Configure

### 5.1 Set environment variables

Put these in your shell profile (`~/.zshrc`, `~/.bashrc`, or Windows env vars):

```bash
export DISCORD_BOT_TOKEN="<token from §2.2>"
export OPENAI_API_KEY="<key from §3>"
```

Reload your shell. Verify:

```bash
echo $DISCORD_BOT_TOKEN      # should print the token
echo $OPENAI_API_KEY         # should print the key
```

### 5.2 Run `tmi init`

```bash
tmi init --meetings-repo ~/tangerine-meetings --target-repo /path/to/your/knowledge-repo
```

This:
- Creates `~/.tmi/config.yaml` from a template
- `git init`s the meetings repo if needed
- Verifies `claude` and `node` are on PATH (warns if not)

### 5.3 Edit `~/.tmi/config.yaml`

Open the file. Fill in:

- `discord.guild_id`: from §2.6
- `team[]`: one entry per teammate — `alias`, `display_name`, `discord_id` (from §2.7; optional but recommended)
- `output_adapters[0].target_repo`: path to the repo where decisions get written (your Claude Code knowledge repo)
- `output_adapters[0].files.*`: verify paths to your `CLAUDE.md`, `knowledge/`, `session-state.md`

Leave `whisper.api_key_env` and `discord.bot_token_env` as the defaults (`OPENAI_API_KEY` / `DISCORD_BOT_TOKEN`). These are env var *names*, not values.

Save.

---

## 6. Your first meeting

End-to-end happy path.

### 6.1 Create the meeting

```bash
tmi new "test meeting"
# prints: /path/to/tangerine-meetings/meetings/2026-04-25-test-meeting
```

### 6.2 Prep (each member, separately)

```bash
tmi prep --alias daizhe
# interactive Claude session. Describe topics, goals, expected disagreements.
# type `done` when finished.
# intent locked -> intents/daizhe.md
```

Each team member runs this on their own machine with their own alias. Intents are private per-author; the wrap step pools them.

### 6.3 Start the meeting

One person runs:

```bash
tmi start
```

This spawns the Discord bot and the observer subprocess. The terminal prints a status banner with tail commands.

### 6.4 Bring the bot into voice

In Discord, join a voice channel. Type:

```
/tma-join
```

(Or whatever prefix you set — default is `tmi`, so `/tmi-join`.)

Bot joins. Talk normally. Transcript writes live to `meetings/<id>/transcript.md`.

### 6.5 End the meeting

In Discord:

```
/tmi-leave
```

Bot leaves and (by default) triggers `tmi wrap` automatically. Or run it manually:

```bash
tmi wrap
# wrapped  summary=summary.md diff_blocks=4
```

### 6.6 Review the diff

```bash
tmi review
```

Interactive prompt for each diff block:

```
Block 1/4  ·  knowledge/session-state.md  ·  append
Reason: v1 scope decision (Topic 1)
Refs: L47, L52, L58
[a]pprove  [r]eject  [e]dit  [s]kip  [q]uit
>
```

`e` opens `$EDITOR` on the block. On save, the edited body replaces the original.

### 6.7 Apply to your knowledge repo

```bash
tmi apply
# applied 3 file(s) commit=4617800
# Reminder: cd "<target_repo>" && git push
```

TMA commits in your target repo but **never pushes**. Push manually after you're happy.

Done. You've run a meeting end-to-end.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Bot doesn't appear in server member list | Re-generate invite URL with BOTH `bot` + `applications.commands` scopes (§2.4). |
| `/tmi-join` not in Discord slash command picker | Wait 5 min for global command sync, or set `discord.guild_id` in config and restart bot (guild commands register instantly). Ctrl+R in Discord client also forces a refresh. |
| `transcript.md` stays empty | Check `OPENAI_API_KEY` resolves in the bot's environment. `tail -f meetings/<id>/.tmi/bot.log` shows Whisper errors. |
| `claude --version` fails | `claude` CLI not on PATH. Install Claude Code, or set `claude.cli_path` to an absolute path in config. |
| `tmi prep` hangs | Observer subprocess stuck. Ctrl-C, check `.tmi/observer.log`. Run with `--mock-claude` to bypass the real subprocess and verify the CLI path works. |
| `tmi apply` refuses with "uncommitted changes in target_repo" | Commit or stash changes in your target repo first, then `tmi apply --retry`. Or `--force` to override (not recommended). |
| Bot reconnect loop | `reconnect_count` hits 3 → state → `failed_bot`. Check Discord token still valid, network stable. |
| Windows path issues | Use forward slashes in config (`C:/Users/...`) — the CLI normalizes via `pathlib.Path`. |

Logs live at:
- Bot: `meetings/<id>/.tmi/bot.log`
- Observer: `meetings/<id>/.tmi/observer.log`
- CLI: `~/.tmi/tmi.log`

---

## 8. Mock mode (testing without Discord or real Claude)

For local dev, smoke tests, or CI:

### Bot dry-run (no Discord connection)

```bash
node bot/dist/index.js \
  --meeting-id=test \
  --meeting-dir=/path/to/meeting \
  --config=/path/to/config.yaml \
  --dry-run
```

Writes one synthetic transcript line and exits. No voice connection, no Whisper call.

### Claude subprocess stub

```bash
TMI_CLAUDE_MODE=stub tmi prep
TMI_CLAUDE_MODE=stub tmi wrap
```

Or pass `--mock-claude` to individual commands. Observer returns canned JSON instead of calling the real `claude` binary. Useful for CI and offline dev.

### Full offline E2E

```bash
TMI_CLAUDE_MODE=stub tmi new "ci test" --participants daizhe
TMI_CLAUDE_MODE=stub tmi prep --alias daizhe
TMI_CLAUDE_MODE=stub tmi start --no-bot
# ... write fixture transcript lines into meetings/<id>/transcript.md ...
TMI_CLAUDE_MODE=stub tmi wrap
tmi review --auto-approve-all
tmi apply
```

Everything except the git ops is mocked. Runs in under 10 seconds on CI.

---

## 9. Next steps

- Run `tmi --help` to see all commands.
- Read [INTERFACES.md](INTERFACES.md) for the full contract if you're extending TMA.
- File bugs at https://github.com/Tangerine-Intelligence/tangerine-meeting-live/issues.
