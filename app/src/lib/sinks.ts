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

// === wave 7 ===
// v1.9.3 honesty pass: same vocabulary as SourceStatus.
//   "shipped" — the channel is wired (browser-ext + MCP server are real
//                packages in this repo; user can install them today)
//   "beta"    — wired but unvalidated end-to-end on Windows
//   "coming"  — placeholder, no implementation yet
export type SinkStatus = "shipped" | "beta" | "coming";
// === end wave 7 ===

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

// === wave 7 ===
// v1.9.3 honesty pass:
//   - browser-ext + MCP server: source code lives in `browser-ext/` and
//     `mcp-server/` of this repo — they're "shipped" (installable) but
//     end-to-end Tangerine integration is still a manual flow, so we
//     mark them "beta" and call out the manual install in the longBlurb.
//   - local-ws server: Rust side has `get_ws_port` / launch logic; the
//     surface to *expose* this to a user (start/stop button) is still
//     not wired into the Sinks page — keep "coming" with v1.10 marker.
export const SINKS: SinkDef[] = [
  {
    id: "browser",
    title: "Browser extension",
    produces: "Tangerine button on ChatGPT / Claude.ai / Gemini",
    blurb: "Beta — install from /browser-ext (manual load).",
    longBlurb:
      "Source lives in this repo at `browser-ext/`. Today it's a manual unpacked-extension load — open `chrome://extensions`, enable developer mode, point at `browser-ext/dist/`. Once loaded, visit ChatGPT, Claude.ai, or Gemini — a Tangerine button appears in the composer that injects relevant memory atoms before your prompt. Chrome Web Store listing lands in v1.10.",
    icon: Globe,
    status: "beta",
    comingIn: "v1.10 (Web Store)",
  },
  {
    id: "mcp",
    title: "MCP server",
    produces: "query_team_memory() tool in Claude Code / Cursor",
    blurb: "Run `npx tangerine-mcp@latest` and point your AI tool at it.",
    longBlurb:
      "Source lives in this repo at `mcp-server/`. Add the snippet shown on /ai-tools/cursor (or /ai-tools/claude-code etc.) to your MCP config — your editor gets a `query_team_memory()` tool. Claude can ask 'what did we decide about auth last sprint?' and get the answer from your memory dir, in context, without you switching windows.",
    icon: Plug,
    status: "shipped",
  },
  {
    id: "local-ws",
    title: "Local WS server",
    produces: "ws://127.0.0.1:7860 — local-only event stream",
    blurb: "Coming v1.10 — beta tester signup welcome.",
    longBlurb:
      "When enabled, Tangerine binds a WebSocket on localhost so locally-running agents (Ollama-backed assistants, custom scripts, Raycast extensions, etc) can subscribe to the live memory event stream without going through a sink. The Rust side already exposes a port via `get_ws_port`; the start/stop UI on this page lands in v1.10. Localhost only — never exposed to the network.",
    icon: Radio,
    status: "coming",
    comingIn: "v1.10",
  },
];
// === end wave 7 ===

export function findSink(id: SinkId): SinkDef {
  const s = SINKS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown sink id: ${id}`);
  return s;
}
