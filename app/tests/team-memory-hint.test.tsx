/**
 * v1.17.1 — TeamMemoryHint copy-CTA card.
 *
 * Coverage:
 *   1. Renders the canonical `@~/.tangerine-memory/TEAM_INDEX.md` line.
 *   2. Mounts a copy button with the correct test-id.
 *   3. Click → writes the line to the clipboard + flips the button
 *      label to "Copied".
 *   4. Click → fires the `writeTeamIndex` Tauri wrapper as a best-effort
 *      kick (mocked).
 *   5. Clipboard write failure surfaces an inline error message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

import { TeamMemoryHint } from "../src/components/onboarding/TeamMemoryHint";

// Mock the Tauri wrapper module so the spec doesn't need a Tauri host.
vi.mock("../src/lib/tauri", () => ({
  writeTeamIndex: vi.fn().mockResolvedValue({
    path: "~/.tangerine-memory/TEAM_INDEX.md",
    atoms_scanned: 3,
    bytes_written: 512,
  }),
}));

import { writeTeamIndex } from "../src/lib/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("v1.17.1 TeamMemoryHint", () => {
  it("renders the canonical CLAUDE.md import line", () => {
    render(<TeamMemoryHint />);
    const line = screen.getByTestId("team-memory-hint-line");
    expect(line.textContent).toBe("@~/.tangerine-memory/TEAM_INDEX.md");
  });

  it("renders a copy button with the test id", () => {
    render(<TeamMemoryHint />);
    const btn = screen.getByTestId("team-memory-hint-copy");
    expect(btn.textContent).toContain("Copy import line");
  });

  it("clicking copy writes the line to navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<TeamMemoryHint />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-memory-hint-copy"));
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("@~/.tangerine-memory/TEAM_INDEX.md");
    });
    expect(screen.getByTestId("team-memory-hint-copy").textContent).toContain("Copied");
  });

  it("clicking copy also fires writeTeamIndex as a best-effort kick", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<TeamMemoryHint />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-memory-hint-copy"));
    });
    await waitFor(() => {
      expect(writeTeamIndex).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces an inline error when clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<TeamMemoryHint />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("team-memory-hint-copy"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("team-memory-hint-err")).toBeInTheDocument();
    });
  });
});
