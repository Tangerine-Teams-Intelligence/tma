// === wave 15 ===
/**
 * Wave 15 — Cmd+K palette memory-content search.
 *
 * Covers the wave-15 deliverable: the CommandPalette extends its
 * launcher beyond static routes / actions / shortcuts into the
 * markdown corpus under `~/.tangerine-memory/`. New rows render
 * under a "MEMORY" section header with vendor color dots; the
 * inline status row shows "Searching memory…" while the IPC is
 * in flight and "No memory matches" when the dir came back empty.
 *
 * We mock `@/lib/tauri` to control the `searchAtoms` round-trip
 * deterministically — the real Rust walker is exercised by the
 * cargo test suite under `commands::search::tests`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Hoisted mocks — see existing wave10-git-sync-container.test.tsx for
// the pattern. We need these in place BEFORE the SUT module loads,
// otherwise `CommandPalette` would close over the real `safeInvoke`
// fallbacks (which return [] for searchAtoms — fine in some tests
// but not the success-path one).
const tauriMocks = vi.hoisted(() => ({
  searchAtoms: vi.fn(),
  // Stubs for the other tauri.ts imports CommandPalette uses, so
  // the mock module replaces every named export the SUT touches.
  showInFolder: vi.fn(),
  gitSyncPull: vi.fn(),
  gitSyncPush: vi.fn(),
  gitSyncStatus: vi.fn().mockResolvedValue({
    git_initialized: true,
    has_remote: false,
    branch: "main",
    ahead: 0,
    behind: 0,
    last_commit_at: null,
  }),
  setupWizardTestChannel: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    searchAtoms: tauriMocks.searchAtoms,
    showInFolder: tauriMocks.showInFolder,
    gitSyncPull: tauriMocks.gitSyncPull,
    gitSyncPush: tauriMocks.gitSyncPush,
    gitSyncStatus: tauriMocks.gitSyncStatus,
    setupWizardTestChannel: tauriMocks.setupWizardTestChannel,
  };
});

// Stub `searchMemory` (legacy JS-side scan) so the test focuses on
// the new atom row rendering. Otherwise the legacy hit list would
// collide with the atom dedupe path and add noise to the assertions.
vi.mock("@/lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory")>();
  return {
    ...actual,
    searchMemory: vi.fn().mockResolvedValue([]),
  };
});

// Reset mocks before each test so call counters don't leak.
beforeEach(() => {
  tauriMocks.searchAtoms.mockReset();
  tauriMocks.showInFolder.mockReset();
});

afterEach(() => {
  cleanup();
});

import { CommandPalette } from "../src/components/CommandPalette";

function renderPalette(): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <CommandPalette open={true} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onClose };
}

describe("Wave 15 — Cmd+K palette memory search", () => {
  it("renders scored atom rows under the MEMORY section when searchAtoms returns hits", async () => {
    tauriMocks.searchAtoms.mockResolvedValue([
      {
        path: "team/decisions/pricing.md",
        title: "Pricing model",
        snippet: "We picked flat-rate pricing on 2026-04-22.",
        vendor: "claude-code",
        author: "Daizhe",
        timestamp: "2026-04-22T10:00:00Z",
        score: 0.78,
      },
      {
        path: "team/timeline/2026-04-22.md",
        title: "Friday standup",
        snippet: "Pricing was the third agenda item.",
        vendor: "discord",
        author: null,
        timestamp: "2026-04-22T17:00:00Z",
        score: 0.42,
      },
    ]);

    renderPalette();

    const input = screen.getByTestId("command-palette-input");
    // Wave 15 threshold is 3 chars — type at least that many to
    // trigger the IPC.
    fireEvent.change(input, { target: { value: "pricing" } });

    // Spinner appears immediately (effect runs synchronously, IPC
    // pending).
    await waitFor(() => {
      expect(screen.getByTestId("command-palette-memory-searching")).toBeInTheDocument();
    });

    // Atom rows arrive after the mocked promise resolves.
    await waitFor(() => {
      expect(tauriMocks.searchAtoms).toHaveBeenCalledWith({
        query: "pricing",
        limit: 10,
      });
      expect(screen.queryByTestId("command-palette-memory-searching")).not.toBeInTheDocument();
    });

    // Section header renders ("MEMORY" / "记忆").
    const header = await screen.findByTestId("command-palette-section-atom");
    expect(header).toBeInTheDocument();

    // Both atom rows are rendered with their frontmatter titles.
    expect(screen.getByText("Pricing model")).toBeInTheDocument();
    expect(screen.getByText("Friday standup")).toBeInTheDocument();

    // Vendor color dots paint per row.
    const dots = screen.getAllByTestId("command-palette-vendor-dot");
    expect(dots.length).toBe(2);
  });

  it("shows the no-results status row when searchAtoms returns empty", async () => {
    tauriMocks.searchAtoms.mockResolvedValue([]);
    renderPalette();

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "definitely-no-such-atom" } });

    // Wait for the search to resolve and the empty-state row to
    // render.
    await waitFor(() => {
      expect(tauriMocks.searchAtoms).toHaveBeenCalled();
    });
    const emptyRow = await screen.findByTestId("command-palette-memory-empty");
    expect(emptyRow).toBeInTheDocument();
    // Spinner has cleared.
    expect(screen.queryByTestId("command-palette-memory-searching")).not.toBeInTheDocument();
    // No atom section header should render (no rows).
    expect(screen.queryByTestId("command-palette-section-atom")).not.toBeInTheDocument();
  });

  it("does not invoke searchAtoms below the 3-char threshold and navigates on click of an atom row", async () => {
    tauriMocks.searchAtoms.mockResolvedValue([
      {
        path: "team/decisions/pricing.md",
        title: "Pricing model",
        snippet: "Flat-rate pricing chosen.",
        vendor: "cursor",
        author: null,
        timestamp: null,
        score: 0.65,
      },
    ]);

    const { onClose } = renderPalette();
    const input = screen.getByTestId("command-palette-input");

    // Below threshold — no IPC.
    fireEvent.change(input, { target: { value: "pr" } });
    // Let any pending microtasks settle, then assert the mock is
    // still untouched.
    await act(async () => {
      await Promise.resolve();
    });
    expect(tauriMocks.searchAtoms).not.toHaveBeenCalled();
    expect(screen.queryByTestId("command-palette-memory-searching")).not.toBeInTheDocument();

    // At threshold — IPC fires once. We can't easily probe the
    // exact item id (depends on Atom dedupe + ranked order), but
    // we can click the rendered row and assert that navigate was
    // triggered (which calls onClose as a side effect of
    // selection).
    fireEvent.change(input, { target: { value: "pri" } });
    await waitFor(() => {
      expect(tauriMocks.searchAtoms).toHaveBeenCalledTimes(1);
    });
    const row = await screen.findByText("Pricing model");
    fireEvent.click(row);
    // The atom row's `onSelect` calls `navigate(...)` then
    // `onClose()`.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
// === end wave 15 ===
