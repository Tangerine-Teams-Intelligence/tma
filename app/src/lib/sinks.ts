/**
 * Sink registry — every place Tangerine pushes memory back out to.
 *
 * Sinks are read-only consumers of the memory dir. They do NOT run an LLM.
 * Their job is to make the markdown files reachable from the user's existing
 * AI tools (Claude Pro / ChatGPT / Cursor / Claude Code) so those tools can
 * see what the team has been doing.
 *
 * v1.8 Phase 1: this section is rendered as "Advanced" in the sidebar (the
 * AI Tools section is now the first-class surface for end users — sinks are
 * the underlying mechanism, demoted to expert-mode status rows).
 */

import { Globe, Plug, Radio } from "lucide-react";

export type SinkId = "browser" | "mcp" | "local-ws";

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
    id: "local-ws",
    title: "Local WS server",
    produces: "ws://127.0.0.1:7860 — local-only event stream",
    blurb: "Stream memory events to local agents over WebSocket.",
    longBlurb:
      "When enabled, Tangerine binds a WebSocket on localhost so locally-running agents (Ollama-backed assistants, custom scripts, Raycast extensions, etc) can subscribe to the live memory event stream without going through a sink. Localhost only — never exposed to the network.",
    icon: Radio,
    status: "coming",
    comingIn: "v1.9",
  },
];

export function findSink(id: SinkId): SinkDef {
  const s = SINKS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sink id: ${id}`);
  return s;
}
