/**
 * v1.8 Phase 1 — per-tool setup config.
 *
 * Every AI tool the user can wire up to Tangerine has a config row here.
 * The generic <AIToolSetupPage/> component reads this by `id` to render:
 *   - the 3 setup steps (with optional code blocks)
 *   - the 3 demo "Test Query" buttons
 *
 * Order in this array is the order shown in the sidebar.
 *
 * The runtime detection verdict (installed / not_installed / ...) comes from
 * the Rust `detect_ai_tools` / `get_ai_tool_status` Tauri command — that's
 * separate from this static config.
 */

export type AIToolChannel =
  | "mcp"
  | "browser_ext"
  | "ide_plugin"
  | "local_http";

export interface AIToolSetupStep {
  /** Short imperative ("Open Cursor settings"). */
  title: string;
  /** Free-form description. May be empty when the title says it all. */
  body: string;
  /** Optional snippet shown in a <pre> block under the body. */
  code?: string;
}

export interface AIToolConfig {
  /** Stable id matching the Rust catalog ("cursor", "claude-code", ...). */
  id: string;
  /** Display name ("Cursor", "Claude Code", ...). */
  name: string;
  /** How Tangerine wires into this tool. Drives status copy in the page. */
  channel: AIToolChannel;
  /** Where to send the user when the tool isn't installed. */
  install_url: string;
  /** Exactly 3 setup steps shown as a numbered list. */
  setup_steps: AIToolSetupStep[];
  /** Exactly 3 demo queries surfaced as 🍊 Test Query buttons. */
  preset_queries: string[];
}

/**
 * Default 3 demo queries shared by every tool. Phase 1 returns mock answers;
 * Phase 3 will route these through the session-borrower so the actual
 * upstream LLM answers.
 */
export const DEFAULT_QUERIES: string[] = [
  "上周我们决定了什么?",
  "下次跟 David 开会要带什么 context?",
  "Project tangerine-teams-app 当前 status?",
];

/**
 * Standard MCP server JSON snippet used by Cursor / Claude Code / Codex /
 * Windsurf. Keeping a single string source-of-truth so we don't drift.
 */
const TANGERINE_MCP_JSON = `{
  "mcpServers": {
    "tangerine": {
      "command": "npx",
      "args": ["-y", "tangerine-mcp@latest"]
    }
  }
}`;

export const AI_TOOLS_CONFIG: AIToolConfig[] = [
  // ========================================================================
  // MCP-channel tools — local config file edit, no browser involved.
  // ========================================================================
  {
    id: "cursor",
    name: "Cursor",
    channel: "mcp",
    install_url: "https://cursor.sh/",
    setup_steps: [
      {
        title: "Open Cursor settings",
        body: "Cmd+, on Mac, Ctrl+, on Windows.",
      },
      {
        title: "Add Tangerine MCP",
        body: "Edit `~/.cursor/mcp.json`. Paste:",
        code: TANGERINE_MCP_JSON,
      },
      {
        title: "Restart Cursor",
        body: "Quit and reopen. The Tangerine tools appear under MCP.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    channel: "mcp",
    install_url: "https://docs.claude.com/en/docs/claude-code",
    setup_steps: [
      {
        title: "Open ~/.claude/mcp_servers.json",
        body: "Create the file if missing.",
      },
      {
        title: "Add Tangerine entry",
        body: "Paste this into the file:",
        code: TANGERINE_MCP_JSON,
      },
      {
        title: "Reload Claude Code",
        body: "Run `claude --reload-mcp` or restart your session.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
  {
    id: "codex",
    name: "Codex",
    channel: "mcp",
    // Placeholder: there's no canonical install URL we can point at yet.
    install_url: "https://platform.openai.com/",
    setup_steps: [
      {
        title: "Locate Codex MCP config",
        body: "Codex CLI reads `~/.codex/mcp.json`.",
      },
      {
        title: "Add Tangerine entry",
        body: "Paste this into the file:",
        code: TANGERINE_MCP_JSON,
      },
      {
        title: "Restart codex shell",
        body: "Exit any running codex sessions and reopen.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    channel: "mcp",
    install_url: "https://codeium.com/windsurf",
    setup_steps: [
      {
        title: "Open Windsurf settings → MCP",
        body: "Settings panel has a dedicated MCP section.",
      },
      {
        title: "Add Tangerine server",
        body: "Paste this MCP server entry:",
        code: TANGERINE_MCP_JSON,
      },
      {
        title: "Restart Windsurf",
        body: "Quit and reopen. The Tangerine tools appear under MCP.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },

  // ========================================================================
  // Browser-extension tools — Tangerine borrows the existing web session.
  // ========================================================================
  {
    id: "claude-ai",
    name: "Claude.ai",
    channel: "browser_ext",
    install_url: "https://claude.ai/",
    setup_steps: [
      {
        title: "Install Tangerine browser extension",
        body: "Get it from Chrome Web Store or load unpacked from your Tangerine release.",
      },
      {
        title: "Visit claude.ai",
        body: "Sign in as you normally do — Tangerine borrows your session.",
      },
      {
        title: "Click the 🍊 button",
        body: "Appears next to the message input. One click injects team memory into your prompt.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    channel: "browser_ext",
    install_url: "https://chatgpt.com/",
    setup_steps: [
      {
        title: "Install Tangerine browser extension",
        body: "Get it from Chrome Web Store or load unpacked from your Tangerine release.",
      },
      {
        title: "Visit chatgpt.com",
        body: "Works on chat.openai.com too. Sign in as you normally do — Tangerine borrows your session.",
      },
      {
        title: "Click the 🍊 button",
        body: "Appears next to the message input. One click injects team memory into your prompt.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
  {
    id: "gemini",
    name: "Gemini",
    channel: "browser_ext",
    install_url: "https://gemini.google.com/",
    setup_steps: [
      {
        title: "Install Tangerine browser extension",
        body: "Get it from Chrome Web Store or load unpacked from your Tangerine release.",
      },
      {
        title: "Visit gemini.google.com",
        body: "Sign in with your Google account — Tangerine borrows your session.",
      },
      {
        title: "Click the 🍊 button",
        body: "Appears next to the message input. One click injects team memory into your prompt.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },

  // ========================================================================
  // IDE-plugin tools — VS Code extension etc.
  // ========================================================================
  {
    id: "copilot",
    name: "GitHub Copilot",
    channel: "ide_plugin",
    install_url: "https://github.com/features/copilot",
    setup_steps: [
      {
        title: "Install GitHub Copilot in VS Code",
        body: "Already done if you've been using it.",
      },
      {
        title: "Install Tangerine VS Code extension",
        body: "Search 'Tangerine' in extensions, click Install.",
      },
      {
        title: "Sign in to Tangerine",
        body: "Click the Tangerine icon in the activity bar.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },

  // ========================================================================
  // Browser-extension tools (cont.) — kept after Copilot to mirror sidebar.
  // ========================================================================
  {
    id: "v0",
    name: "v0",
    channel: "browser_ext",
    install_url: "https://v0.dev/",
    setup_steps: [
      {
        title: "Install Tangerine browser extension",
        body: "Get it from Chrome Web Store or load unpacked from your Tangerine release.",
      },
      {
        title: "Visit v0.dev",
        body: "Sign in as you normally do — Tangerine borrows your session.",
      },
      {
        title: "Click the 🍊 button",
        body: "Appears next to the message input. One click injects team memory into your prompt.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },

  // ========================================================================
  // Local HTTP tool — Ollama runs on localhost.
  // ========================================================================
  {
    id: "ollama",
    name: "Ollama",
    channel: "local_http",
    install_url: "https://ollama.com/",
    setup_steps: [
      {
        title: "Install Ollama",
        body: "Mac/Linux: run the curl below. Windows: download from ollama.com.",
        code: "curl -fsSL https://ollama.com/install.sh | sh",
      },
      {
        title: "Pull a model",
        body: "Any modern instruct model works. Recommended:",
        code: "ollama pull llama3.1:8b-instruct-q4_K_M",
      },
      {
        title: "Start Ollama service",
        body: "Runs on localhost:11434 — Tangerine auto-detects.",
      },
    ],
    preset_queries: DEFAULT_QUERIES,
  },
];

/** Look up a single tool config by id. Returns undefined for unknown ids. */
export function getAIToolConfig(id: string): AIToolConfig | undefined {
  return AI_TOOLS_CONFIG.find((t) => t.id === id);
}
