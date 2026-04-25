# Target Repo (sample)

This is a stripped-down example of what a Claude Code project's `CLAUDE.md` looks like AFTER `tmi apply` ran on the demo meeting (2026-04-22-david-tma-kickoff).

## Project rules

- Always work from `INTERFACES.md` as the cross-component contract — never invent schemas locally.
- Use UTF-8 throughout. Windows subprocess output must be reconfigured to UTF-8 explicitly.
- Bot voice intents in Discord developer portal: enable Server Members Intent. OAuth scopes: `bot` + `applications.commands`.

### TMA 部署铁律（v1）
- @discordjs/voice 0.17 已有 npm deprecation warning（旧加密模式）。upgrade path 进 INTERFACES.md §10。每月 review 一次升级状态。

## See also

- `knowledge/session-state.md` — current week status, recent meetings
- `knowledge/tma-decisions.md` — TMA architecture / stack decisions log
