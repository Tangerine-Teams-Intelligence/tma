# tangerine-mcp

MCP server that exposes Tangerine team memory to Claude Code, Cursor, Claude Desktop, and any other MCP-compatible AI client.

Once installed, your AI tool gains a `query_team_memory` tool it can call autonomously — no copy-paste, no manual injection. Ask "what did we decide about Whisper?" and the model pulls the relevant decision file straight from your local team memory.

---

## Try in 30 seconds (no install, no Tangerine app needed)

The package ships with a bundled sample team memory. Add this to your AI tool's MCP config:

**Cursor** (`~/.cursor/mcp.json`):

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

**Claude Code** (`~/.config/claude/config.json` on macOS/Linux, `%APPDATA%\Claude\config.json` on Windows):

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

Restart your AI tool, then ask:

- *"what's our team's pricing?"*
- *"what did we decide about postgres vs mongo?"*
- *"who was in the roadmap sync meeting?"*

You're querying a sample team memory baked into the npm package. To plug in your real team's memory, install the Tangerine desktop app: <https://github.com/Tangerine-Teams-Intelligence/tma>

---

## Install for real use

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
tangerine-mcp 0.2.0
MCP server that exposes Tangerine team memory to any MCP-compatible AI client.

USAGE
  npx tangerine-mcp [options]
  tangerine-mcp [options]

OPTIONS
  --demo            Use the bundled sample team memory (Daizhe + David roadmap
                    sync, $20/seat pricing decision, postgres-over-mongo).
                    Perfect for "try in 30 seconds" demos. Overrides --root.
  --root <path>     Memory root directory. Overrides $TANGERINE_MEMORY_ROOT.
                    Default: ~/.tangerine-memory
  -h, --help        Show this help and exit.
  -v, --version     Print version and exit.

ENVIRONMENT
  TANGERINE_MEMORY_ROOT   Memory root if --root is not given.
```

The server speaks MCP over stdio — `stdout` is JSONRPC, `stderr` is logs.

## Add to Claude Code (real team memory)

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

## Add to Cursor (real team memory)

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

## What it exposes

### Tool: `query_team_memory`

Search team memory for a substring. Returns top matching files with frontmatter, snippet, and content preview.

Input:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Substring to search across all team memory markdown" },
    "limit": { "type": "number", "default": 5, "minimum": 1, "maximum": 20 }
  },
  "required": ["query"]
}
```

Returns (per match):

```json
{
  "file": "decisions/pricing-20-seat.md",
  "title": "Pricing $20/seat 3 seat min",
  "frontmatter": { "date": "2026-04-25", "source": "meeting" },
  "snippet": "...lock pricing before HN launch. I'm thinking $20/seat with 3 seat min...",
  "content_preview": "<first 4000 chars of body>",
  "matches": 3
}
```

### Resource: `team-memory://`

- `team-memory://` — JSON index of every file (path, title, frontmatter)
- `team-memory://decisions/pricing-20-seat.md` — full markdown content with frontmatter

## Behavior

- **Memory root resolution**: `--demo` flag → `--root` flag → `$TANGERINE_MEMORY_ROOT` → `~/.tangerine-memory`
- **Missing root**: logs to stderr, returns empty results, doesn't crash
- **Search**: case-insensitive substring across body (frontmatter stripped), ranked by descending match count
- **Caps**: 1000 files, 4000-char content preview, 20 results max
- **Performance**: < 100ms for 100 files of ~5KB each
- **Logging**: stderr only (stdout reserved for MCP JSONRPC)

## Development

```bash
git clone https://github.com/Tangerine-Teams-Intelligence/tma.git
cd tma/mcp-server
npm install
npm run build
npm test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).