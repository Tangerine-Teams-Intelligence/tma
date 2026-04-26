# tangerine-mcp

> **Align every AI tool on your team with your team's actual work.**

Your team uses Cursor, Claude, ChatGPT — but each AI sees a different slice of what your team's actually doing. This MCP server is the Sink that aligns them: it exposes Tangerine team memory to Claude Code, Cursor, Claude Desktop, and any other MCP-compatible AI client.

Once installed, your AI tool gains 7 tools it can call autonomously — no copy-paste, no manual injection:

| Tool | Calls when… |
|---|---|
| `query_team_memory(query, limit?)` | the user asks about prior decisions, meetings, anything that might be in team context |
| `get_today_brief()` | session start — pulls today's brief so the AI loads context before the user asks |
| `get_my_pending(user)` | the user asks "what's on my plate", "what do I owe", "what's overdue" |
| `get_for_person(name)` | "what's <name> been working on", "catch me up on <name>", before a 1:1 |
| `get_for_project(slug)` | "status of <project>", "what's happening with <project>" |
| `get_thread_state(topic)` | "where did we land on <topic>", "is <topic> still open" |
| `get_recent_decisions(days?)` | "what did we decide recently", session start to load decision context |

Ask Claude "what did we decide about Whisper?" → it auto-calls `query_team_memory("Whisper")`.
Ask "what's on my plate?" → it auto-calls `get_my_pending("daizhe")`.
No prompt engineering required.

## Install

```bash
npx tangerine-mcp           # zero-config, uses ~/.tangerine-memory
```

Or install globally:

```bash
npm install -g tangerine-mcp
tangerine-mcp --help
```

## Usage

```text
tangerine-mcp 0.1.0
MCP server that exposes Tangerine team memory to any MCP-compatible AI client.

USAGE
  npx tangerine-mcp [options]
  tangerine-mcp [options]

OPTIONS
  --root <path>     Memory root directory. Overrides $TANGERINE_MEMORY_ROOT.
                    Default: ~/.tangerine-memory
  -h, --help        Show this help and exit.
  -v, --version     Print version and exit.

ENVIRONMENT
  TANGERINE_MEMORY_ROOT   Memory root if --root is not given.
```

The server speaks MCP over stdio — `stdout` is JSONRPC, `stderr` is logs.

## Add to Claude Code

Edit `~/.config/claude/config.json` (macOS/Linux) or `%APPDATA%\Claude\config.json` (Windows):

```json
{
  "mcpServers": {
    "tangerine": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp"]
    }
  }
}
```

Restart Claude Code. The `query_team_memory` tool appears in the tool list. Ask Claude anything about prior decisions and it'll call the tool automatically.

## Add to Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tangerine": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp"]
    }
  }
}
```

## Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "tangerine": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp"]
    }
  }
}
```

## Custom memory root

```json
{
  "mcpServers": {
    "tangerine": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp", "--root", "/path/to/team/memory"]
    }
  }
}
```

Or set the env var:

```bash
export TANGERINE_MEMORY_ROOT=/path/to/team/memory
npx tangerine-mcp
```

## Memory layout

The server expects a directory of markdown files, optionally organized into the standard Tangerine subdirectories:

```text
~/.tangerine-memory/
├── meetings/
│   └── 2026-04-25-v15-scope.md
├── decisions/
│   └── pricing-20-seat.md
├── people/
├── projects/
├── threads/
└── glossary/
```

Each `.md` file may have YAML frontmatter:

```markdown
---
title: Pricing $20/seat 3 seat min
date: 2026-04-25
source: meeting
---

We need to lock pricing before HN launch...
```

Frontmatter is parsed via [gray-matter](https://github.com/jonschlinkert/gray-matter) and surfaced in tool results.

## Response envelope (Stage 1 AGI hook 4)

**Every** tool response is wrapped in this envelope — same shape, every tool, so MCP clients (Cursor, Claude Code, Claude Desktop) can render confidence indicators, freshness badges, and source attribution from day one. Stage 2 fills in the placeholder fields with real values.

```json
{
  "data":              {"...": "actual tool payload — shape depends on the tool"},
  "confidence":        1.0,
  "freshness_seconds": 60,
  "source_atoms":      ["evt-2026-04-25-aBc12dEf", "..."],
  "alternatives":      [],
  "reasoning_notes":   null
}
```

| Field | Stage 1 (now) | Stage 2 (~6 mo out) |
|---|---|---|
| `confidence` | always `1.0` | LLM-graded 0..1 trust score |
| `freshness_seconds` | seconds since the freshest source atom / file mtime | same |
| `source_atoms` | atom ids that contributed (`[]` for substring search) | full citation graph |
| `alternatives` | always `[]` | competing interpretations when ambiguous |
| `reasoning_notes` | always `null` | reasoning loop annotation |

Schema is also documented in `<root>/.tangerine/SCHEMA.md` (written by the desktop daemon).

## What it exposes

### Tool: `query_team_memory`

Substring search across all memory markdown.

Input:

```json
{
  "query": { "type": "string" },
  "limit": { "type": "number", "default": 5, "minimum": 1, "maximum": 20 }
}
```

`data` field shape:

```json
{
  "query": "pricing",
  "root": "/path/to/memory",
  "searched": 12,
  "hits": [
    {
      "file": "decisions/pricing-20-seat.md",
      "title": "Pricing $20/seat 3 seat min",
      "frontmatter": {"date": "2026-04-25", "source": "meeting"},
      "snippet": "...$20/seat with 3 seat min...",
      "content_preview": "<first 4000 chars>",
      "matches": 3
    }
  ]
}
```

### Tool: `get_today_brief()`

Returns today's daily brief from `<sidecar>/briefs/<today>.md` if the desktop daemon has written it, otherwise synthesises one from the timeline index. `data.origin` is `"brief_file"` | `"synthesised"` | `"empty"`.

### Tool: `get_my_pending(user)`

Open action items where `lifecycle.owner == user` AND `lifecycle.closed` is null. Sorted overdue-first.

### Tool: `get_for_person(name)`

Last 30 days, max 20 atoms involving the named person (matches `refs.people` and `actors`).

### Tool: `get_for_project(slug)`

Last 30 days, max 20 atoms in the project (matches `refs.projects`).

### Tool: `get_thread_state(topic)`

Chronological atoms attached to the thread, plus thread `status` (`active` | `closed`), `decisions_resolved` list, and the verbatim `narrative` from `memory/threads/<topic>.md` if present.

### Tool: `get_recent_decisions(days?)`

Decision atoms (`kind == "decision"`) in the last N days (default 7, max 365). Capped at 50 results, newest first.

### Resource: `team-memory://`

- `team-memory://` — JSON index of every file (path, title, frontmatter)
- `team-memory://decisions/pricing-20-seat.md` — full markdown content with frontmatter

## Behavior

- **Memory root resolution**: `--root` flag → `$TANGERINE_MEMORY_ROOT` → `~/.tangerine-memory`
- **Missing root**: logs to stderr, returns empty results, doesn't crash
- **Search**: case-insensitive substring across body (frontmatter stripped), ranked by descending match count
- **Caps**: 1000 files, 4000-char content preview, 20 results max
- **Performance**: < 100ms for 100 files of ~5KB each
- **Logging**: stderr only (stdout reserved for MCP JSONRPC)

## Development

```bash
git clone https://github.com/Tangerine-Intelligence/tangerine-meeting-live.git
cd tangerine-meeting-live/mcp-server
npm install
npm run build
npm test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
