import { describe, expect, it } from "vitest";
import {
  pickPrimary,
  channelLabel,
  AI_TOOL_PRIORITY,
  type AIToolStatus,
} from "../src/lib/ai-tools";

/**
 * Build a status row with sane defaults so each test only specifies the
 * fields it cares about.
 */
function status(
  id: string,
  status: AIToolStatus["status"],
  channel: AIToolStatus["channel"] = "mcp",
): AIToolStatus {
  return {
    id,
    name: id,
    status,
    channel,
    install_url: null,
  };
}

describe("pickPrimary", () => {
  it("returns null when nothing is installed", () => {
    expect(
      pickPrimary([
        status("cursor", "not_installed"),
        status("chatgpt", "browser_ext_required"),
      ]),
    ).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(pickPrimary([])).toBeNull();
  });

  it("picks cursor when cursor is installed", () => {
    expect(
      pickPrimary([
        status("cursor", "installed"),
        status("claude-code", "installed"),
      ]),
    ).toBe("cursor");
  });

  it("picks claude-code when cursor is missing but claude-code is installed", () => {
    expect(
      pickPrimary([
        status("cursor", "not_installed"),
        status("claude-code", "installed"),
        status("chatgpt", "installed"),
      ]),
    ).toBe("claude-code");
  });

  it("falls all the way down to ollama if needed", () => {
    expect(
      pickPrimary([
        status("ollama", "installed", "local_http"),
        status("v0", "browser_ext_required", "browser_ext"),
      ]),
    ).toBe("ollama");
  });

  it("ignores non-installed states (needs_setup, browser_ext_required)", () => {
    expect(
      pickPrimary([
        status("cursor", "needs_setup"),
        status("claude-code", "browser_ext_required"),
        status("codex", "installed"),
      ]),
    ).toBe("codex");
  });

  it("respects the priority order, not the array order", () => {
    // Reverse-order array; cursor should still win.
    expect(
      pickPrimary([
        status("ollama", "installed", "local_http"),
        status("copilot", "installed", "ide_plugin"),
        status("cursor", "installed"),
      ]),
    ).toBe("cursor");
  });

  it("ignores ids outside the catalog", () => {
    expect(
      pickPrimary([
        status("not-a-real-tool", "installed"),
        status("cursor", "installed"),
      ]),
    ).toBe("cursor");
  });
});

describe("AI_TOOL_PRIORITY", () => {
  it("contains exactly the 10 supported ids in canonical order", () => {
    expect(AI_TOOL_PRIORITY).toEqual([
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
    ]);
  });
});

describe("channelLabel", () => {
  it("renders short human labels for every channel kind", () => {
    expect(channelLabel("mcp")).toBe("MCP");
    expect(channelLabel("browser_ext")).toBe("Browser ext");
    expect(channelLabel("ide_plugin")).toBe("IDE");
    expect(channelLabel("local_http")).toBe("Local HTTP");
  });
});
