import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import AIToolSetupPage from "../src/components/ai-tools/AIToolSetupPage";
import * as aiTools from "../src/lib/ai-tools";

/**
 * Wave 4-C — auto-configure card.
 *
 * The card renders only when:
 *   1. The tool is on the MCP channel,
 *   2. Detection reports `installed`, AND
 *   3. We have a known config path for it.
 */

beforeEach(() => {
  vi.restoreAllMocks();
});

function renderPage(toolId: string) {
  return render(
    <MemoryRouter initialEntries={[`/ai-tools/${toolId}`]}>
      <Routes>
        <Route path="/ai-tools/:id" element={<AIToolSetupPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AIToolSetupPage — auto-configure card", () => {
  it("renders auto-configure card when Cursor is detected as installed", async () => {
    vi.spyOn(aiTools, "loadAITools").mockResolvedValue([
      {
        id: "cursor",
        name: "Cursor",
        status: "installed",
        channel: "mcp",
        install_url: "https://cursor.sh/",
      },
    ]);

    renderPage("cursor");

    await waitFor(() => {
      expect(screen.getByTestId("ai-tool-auto-configure")).toBeInTheDocument();
    });
    expect(screen.getByTestId("ai-tool-auto-configure-btn")).toBeInTheDocument();
    // Cursor's MCP config path should be advertised — the auto-configure
    // card is the first occurrence.
    const card = screen.getByTestId("ai-tool-auto-configure");
    expect(card.textContent).toMatch(/~\/\.cursor\/mcp\.json/i);
  });

  it("hides auto-configure card when Cursor is not_installed", async () => {
    vi.spyOn(aiTools, "loadAITools").mockResolvedValue([
      {
        id: "cursor",
        name: "Cursor",
        status: "not_installed",
        channel: "mcp",
        install_url: "https://cursor.sh/",
      },
    ]);

    renderPage("cursor");

    // Wait for detection to settle (loading skeleton replaced).
    await waitFor(() => {
      expect(screen.queryByText(/Detecting Cursor/i)).toBeNull();
    });
    expect(screen.queryByTestId("ai-tool-auto-configure")).toBeNull();
  });

  it("hides auto-configure card for browser-ext tools (Claude.ai)", async () => {
    vi.spyOn(aiTools, "loadAITools").mockResolvedValue([
      {
        id: "claude-ai",
        name: "Claude.ai",
        status: "installed",
        channel: "browser_ext",
        install_url: "https://claude.ai/",
      },
    ]);

    renderPage("claude-ai");

    await waitFor(() => {
      expect(screen.queryByText(/Detecting Claude.ai/i)).toBeNull();
    });
    expect(screen.queryByTestId("ai-tool-auto-configure")).toBeNull();
  });

  it("collapses manual setup behind a disclosure when auto-configure is eligible", async () => {
    vi.spyOn(aiTools, "loadAITools").mockResolvedValue([
      {
        id: "claude-code",
        name: "Claude Code",
        status: "installed",
        channel: "mcp",
        install_url: "https://claude.ai/download",
      },
    ]);

    renderPage("claude-code");

    await waitFor(() => {
      expect(screen.getByTestId("ai-tool-auto-configure")).toBeInTheDocument();
    });
    // Manual disclosure summary present.
    expect(screen.getByTestId("ai-tool-manual-toggle")).toBeInTheDocument();
    // The disclosure label should clearly say it's manual.
    expect(screen.getByText(/Manual setup/i)).toBeInTheDocument();
  });

  it("auto-configure click writes the snippet to clipboard", async () => {
    vi.spyOn(aiTools, "loadAITools").mockResolvedValue([
      {
        id: "cursor",
        name: "Cursor",
        status: "installed",
        channel: "mcp",
        install_url: "https://cursor.sh/",
      },
    ]);

    let captured = "";
    const writeText = vi.fn().mockImplementation((s: string) => {
      captured = s;
      return Promise.resolve();
    });
    Object.assign(globalThis.navigator, {
      clipboard: { writeText },
    });

    renderPage("cursor");

    await waitFor(() => {
      expect(screen.getByTestId("ai-tool-auto-configure-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("ai-tool-auto-configure-btn"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    // Snippet must be the Tangerine MCP server JSON (asserted on the
    // unique `tangerine-mcp@latest` token from ai-tools-config.ts).
    expect(captured).toContain("tangerine-mcp@latest");
    expect(captured).toContain("mcpServers");
  });
});
