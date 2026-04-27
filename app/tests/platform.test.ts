// === wave 5-γ ===
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMac,
  isWindows,
  kbdShortcut,
  mcpConfigDisplayPath,
} from "../src/lib/platform";

/**
 * Wave 5-γ — cross-platform reliability.
 *
 * The AI-tool setup flow surfaces hardcoded POSIX paths (`~/.cursor/mcp.json`)
 * that don't exist on Windows. `mcpConfigDisplayPath()` is the runtime
 * translator that swaps the home prefix to `%USERPROFILE%\` and forward
 * slashes to backslashes when the host is Windows. Everything else passes
 * through unchanged.
 *
 * We can't actually run the test on a different OS, so we mutate
 * `navigator.platform` between tests. jsdom lets us redefine it via
 * Object.defineProperty.
 */

const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;

function setNavigator(platform: string, userAgent = "") {
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(navigator, "userAgent", {
    value: userAgent || originalUserAgent,
    configurable: true,
  });
}

beforeEach(() => {
  setNavigator(originalPlatform, originalUserAgent);
});

afterEach(() => {
  setNavigator(originalPlatform, originalUserAgent);
});

describe("platform detection", () => {
  it("isWindows is true when navigator.platform contains Win", () => {
    setNavigator("Win32");
    expect(isWindows()).toBe(true);
    expect(isMac()).toBe(false);
  });

  it("isMac is true on MacIntel", () => {
    setNavigator("MacIntel");
    expect(isMac()).toBe(true);
    expect(isWindows()).toBe(false);
  });

  it("falls back to userAgent when navigator.platform is empty", () => {
    setNavigator(
      "",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    expect(isWindows()).toBe(true);
    expect(isMac()).toBe(false);
  });

  it("kbdShortcut renders Ctrl on Windows", () => {
    setNavigator("Win32");
    expect(kbdShortcut("k")).toBe("Ctrl+K");
  });

  it("kbdShortcut renders the Apple command symbol on macOS", () => {
    setNavigator("MacIntel");
    expect(kbdShortcut("k")).toBe("⌘K");
  });
});

describe("mcpConfigDisplayPath — wave 5-γ", () => {
  it("on macOS leaves ~/.cursor/mcp.json untouched", () => {
    setNavigator("MacIntel");
    expect(mcpConfigDisplayPath("~/.cursor/mcp.json")).toBe(
      "~/.cursor/mcp.json",
    );
    expect(mcpConfigDisplayPath("~/.claude/mcp_servers.json")).toBe(
      "~/.claude/mcp_servers.json",
    );
    expect(mcpConfigDisplayPath("~/.codex/mcp.json")).toBe("~/.codex/mcp.json");
  });

  it("on Windows swaps the home prefix and slashes", () => {
    setNavigator("Win32");
    expect(mcpConfigDisplayPath("~/.cursor/mcp.json")).toBe(
      "%USERPROFILE%\\.cursor\\mcp.json",
    );
    expect(mcpConfigDisplayPath("~/.claude/mcp_servers.json")).toBe(
      "%USERPROFILE%\\.claude\\mcp_servers.json",
    );
    expect(mcpConfigDisplayPath("~/.codex/mcp.json")).toBe(
      "%USERPROFILE%\\.codex\\mcp.json",
    );
  });

  it("on Linux falls through to the POSIX form", () => {
    setNavigator("Linux x86_64");
    expect(mcpConfigDisplayPath("~/.cursor/mcp.json")).toBe(
      "~/.cursor/mcp.json",
    );
    expect(isWindows()).toBe(false);
    expect(isMac()).toBe(false);
  });

  it("passes non-tilde paths through unchanged on every OS", () => {
    setNavigator("Win32");
    // Windsurf's "Settings → MCP" placeholder is OS-neutral; must not
    // get mutated by the regex.
    expect(mcpConfigDisplayPath("Settings → MCP")).toBe("Settings → MCP");
    setNavigator("MacIntel");
    expect(mcpConfigDisplayPath("Settings → MCP")).toBe("Settings → MCP");
  });

  it("uses userAgent fallback when platform is hidden by privacy mode", () => {
    setNavigator(
      "",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    expect(mcpConfigDisplayPath("~/.cursor/mcp.json")).toBe(
      "%USERPROFILE%\\.cursor\\mcp.json",
    );
  });
});
