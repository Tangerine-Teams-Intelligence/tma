/**
 * AI tools registry — the user's external AI clients (Cursor, Claude Code,
 * ChatGPT, etc) that read team memory through one of three channels:
 *
 *   - `mcp`         → MCP server (Cursor / Claude Code / Codex / Windsurf)
 *   - `browser_ext` → Tangerine browser extension (Claude.ai / ChatGPT /
 *                     Gemini / v0)
 *   - `ide_plugin`  → editor plugin (GitHub Copilot)
 *   - `local_http`  → local HTTP probe (Ollama)
 *
 * The Rust side (`commands/ai_tools.rs::detect_ai_tools`) returns a status row
 * per tool. This module is the typed wrapper + helpers around that command.
 *
 * v1.8 Phase 1 ships the sidebar UI; the per-tool setup pages land in Phase 2.
 */

import { detectAITools } from "./tauri";

/** Mirrors the Rust struct at `commands/ai_tools.rs::AIToolStatus`. */
export interface AIToolStatus {
  /** Stable id — "cursor" | "claude-code" | "codex" | "windsurf" |
   *  "claude-ai" | "chatgpt" | "gemini" | "copilot" | "v0" | "ollama". */
  id: string;
  /** Human-readable name shown in the sidebar row. */
  name: string;
  /**
   * Verdict from the detector:
   *   - `installed`             → green dot, "ready" implicit
   *   - `needs_setup`           → amber dot (e.g. installed but no MCP config)
   *   - `browser_ext_required`  → amber dot, hints user to install our ext
   *   - `not_installed`         → grey dot
   */
  status: "installed" | "not_installed" | "browser_ext_required" | "needs_setup";
  /** How memory reaches this tool. */
  channel: "mcp" | "browser_ext" | "ide_plugin" | "local_http";
  /** Vendor download / install page; shown as "Get it" link when missing. */
  install_url: string | null;
}

/**
 * Auto-pick priority for the ⭐ primary tool. First `installed` row wins.
 * Order is deliberate: editor-integrated MCP clients beat browser-only,
 * Cursor first because it's the most popular among Tangerine's design
 * partner cohort.
 */
export const AI_TOOL_PRIORITY = [
  "cursor",
  "claude-code",
  "codex",
  "windsurf",
  "claude-ai",
  "chatgpt",
  "gemini",
  "copilot",
  "v0",
  "ollama",
] as const;

/**
 * Pure picker — returns the id of the highest-priority `installed` tool, or
 * `null` if nothing is installed. Used on first launch (when
 * `ui.primaryAITool === null`) and exposed for unit tests.
 */
export function pickPrimary(tools: AIToolStatus[]): string | null {
  for (const id of AI_TOOL_PRIORITY) {
    const t = tools.find((x) => x.id === id);
    if (t?.status === "installed") return id;
  }
  return null;
}

/**
 * Human label for the channel column in the sidebar row.
 * Rendered as `via {label}` — kept short so the row doesn't wrap.
 */
export function channelLabel(channel: AIToolStatus["channel"]): string {
  switch (channel) {
    case "mcp":
      return "MCP";
    case "browser_ext":
      return "Browser ext";
    case "ide_plugin":
      return "IDE";
    case "local_http":
      return "Local HTTP";
  }
}

/**
 * Mock fixture returned outside Tauri (vite dev / vitest / Storybook) so the
 * sidebar still renders with realistic data. Mirrors the order in
 * AI_TOOL_PRIORITY; the first row is `installed` so the auto-pick path has
 * something to land on in tests.
 */
const MOCK_TOOLS: AIToolStatus[] = [
  {
    id: "cursor",
    name: "Cursor",
    status: "installed",
    channel: "mcp",
    install_url: "https://cursor.sh/",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    status: "needs_setup",
    channel: "mcp",
    install_url: "https://claude.ai/download",
  },
  {
    id: "codex",
    name: "Codex",
    status: "not_installed",
    channel: "mcp",
    install_url: "https://platform.openai.com/",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    status: "not_installed",
    channel: "mcp",
    install_url: "https://codeium.com/windsurf",
  },
  {
    id: "claude-ai",
    name: "Claude.ai",
    status: "browser_ext_required",
    channel: "browser_ext",
    install_url: "https://claude.ai/",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    status: "browser_ext_required",
    channel: "browser_ext",
    install_url: "https://chat.openai.com/",
  },
  {
    id: "gemini",
    name: "Gemini",
    status: "browser_ext_required",
    channel: "browser_ext",
    install_url: "https://gemini.google.com/",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    status: "not_installed",
    channel: "ide_plugin",
    install_url: "https://github.com/features/copilot",
  },
  {
    id: "v0",
    name: "v0",
    status: "browser_ext_required",
    channel: "browser_ext",
    install_url: "https://v0.dev/",
  },
  {
    id: "ollama",
    name: "Ollama",
    status: "not_installed",
    channel: "local_http",
    install_url: "https://ollama.com/download",
  },
];

/**
 * Loads the AI-tool detection result. Delegates to `detectAITools()` in
 * lib/tauri.ts so vitest / browser-dev fall back to the mock fixture above
 * instead of crashing on the missing Tauri bridge.
 */
export async function loadAITools(): Promise<AIToolStatus[]> {
  return detectAITools(MOCK_TOOLS);
}
