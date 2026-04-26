#!/usr/bin/env node
/**
 * cli.ts — entry point for `npx tangerine-mcp` / `tangerine-mcp` global bin.
 *
 * Flags:
 *   --root <path>   memory root override (else $TANGERINE_MEMORY_ROOT, else ~/.tangerine-memory)
 *   --help, -h      print usage and exit 0
 *   --version, -v   print version and exit 0
 */

import { runStdioServer } from "./server.js";
import { resolveMemoryRoot } from "./memory.js";

const VERSION = "0.1.0";

const HELP = `tangerine-mcp ${VERSION}
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

CONFIG (Claude Code, ~/.config/claude/config.json)
  {
    "mcpServers": {
      "tangerine": { "command": "npx", "args": ["-y", "tangerine-mcp"] }
    }
  }

CONFIG (Cursor, ~/.cursor/mcp.json)
  {
    "mcpServers": {
      "tangerine": { "command": "npx", "args": ["-y", "tangerine-mcp"] }
    }
  }

The server speaks MCP over stdio. Logs go to stderr; stdout is reserved
for JSONRPC traffic.

TOOLS EXPOSED (all responses wrapped in the AGI envelope —
{ data, confidence, freshness_seconds, source_atoms, alternatives, reasoning_notes }):

  - query_team_memory(query, limit?)
      Substring search across the memory root.
  - get_today_brief()
      Today's daily brief from .tangerine/briefs/<today>.md, or
      synthesised from the timeline if the daemon hasn't generated it yet.
  - get_my_pending(user)
      Open action items where lifecycle.owner==user AND lifecycle.closed is null.
  - get_for_person(name)
      Recent atoms (last 30 days, limit 20) involving the named person.
  - get_for_project(slug)
      Recent atoms (last 30 days, limit 20) belonging to a project slug.
  - get_thread_state(topic)
      Chronological atoms attached to a thread + status + decisions resolved.
  - get_recent_decisions(days?)
      Decision atoms in the last N days (default 7, max 50 results).

RESOURCE EXPOSED:
  team-memory://             — JSON index of every memory file
  team-memory://<rel/path>   — full markdown content
`;

interface ParsedArgs {
  root?: string;
  help: boolean;
  version: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, version: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--version" || a === "-v") {
      out.version = true;
    } else if (a === "--root") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        process.stderr.write("[tangerine-mcp] --root requires a path argument\n");
        process.exit(2);
      }
      out.root = next;
      i++;
    } else if (a.startsWith("--root=")) {
      out.root = a.slice("--root=".length);
    } else {
      out.unknown.push(a);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.unknown.length > 0) {
    process.stderr.write(
      `[tangerine-mcp] unknown args: ${args.unknown.join(" ")}\n`,
    );
    process.stderr.write("Run with --help for usage.\n");
    process.exit(2);
  }

  const root = resolveMemoryRoot(args.root);
  process.stderr.write(`[tangerine-mcp] v${VERSION} memory root: ${root}\n`);
  await runStdioServer({ root });
}

main().catch((err) => {
  process.stderr.write(
    `[tangerine-mcp] fatal: ${(err as Error).stack ?? err}\n`,
  );
  process.exit(1);
});
