/**
 * Sink registry — every place Tangerine pushes memory back out to.
 *
 * Sinks are read-only consumers of the memory dir. They do NOT run an LLM.
 * Their job is to make the markdown files reachable from the user's existing
 * AI tools (Claude Pro / ChatGPT / Cursor / Claude Code) so those tools can
 * see what the team has been doing.
 *
 * v1.5 ships none. They land v1.6+.
 */

import { Globe, Plug, Code2 } from "lucide-react";

export type SinkId = "browser" | "mcp" | "api";

export type SinkStatus = "active" | "coming" | "disconnected";

export interface SinkDef {
  id: SinkId;
  title: string;
  /** What the sink does in one phrase. */
  produces: string;
  blurb: string;
  longBlurb: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  status: SinkStatus;
  /** undefined = shipping now. */
  comingIn?: string;
}

export const SINKS: SinkDef[] = [
  {
    id: "browser",
    title: "Browser extension",
    produces: "Tangerine button on ChatGPT / Claude.ai / Gemini",
    blurb: "Inject team memory into your AI chat sessions.",
    longBlurb:
      "Install the Chrome / Edge / Safari extension. Visit ChatGPT, Claude.ai, or Gemini. A Tangerine button appears in the composer. Click it, the extension finds memory files relevant to your prompt, and prepends them — so the chat AI knows what your team decided last week without you re-typing.",
    icon: Globe,
    status: "coming",
    comingIn: "v1.6",
  },
  {
    id: "mcp",
    title: "MCP server",
    produces: "query_team_memory() tool in Claude Code / Cursor",
    blurb: "Expose memory as an MCP tool for your code editor.",
    longBlurb:
      "Run `npx tangerine-mcp` and add it to your Claude Code or Cursor MCP config. Your editor gets a `query_team_memory()` tool — Claude can ask 'what did we decide about auth last sprint?' and get the answer from your memory dir, in context, without you switching windows.",
    icon: Plug,
    status: "coming",
    comingIn: "v1.6",
  },
  {
    id: "api",
    title: "Public API",
    produces: "REST + token auth, query memory programmatically",
    blurb: "Read your team's memory from anything that speaks HTTP.",
    longBlurb:
      "Generate an API token in Settings, hit the public Tangerine API with a query, get the matching memory chunks back as JSON. Use it from internal tools, n8n / Zapier flows, or your own agents.",
    icon: Code2,
    status: "coming",
    comingIn: "v1.7",
  },
];

export function findSink(id: SinkId): SinkDef {
  const s = SINKS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sink id: ${id}`);
  return s;
}
