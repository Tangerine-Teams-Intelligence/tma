// === v1.15.0 wave 1.2 ===
/**
 * W1.2 — AI tool detection grid tests.
 *
 * Coverage matrix (≥24 specs per ship contract):
 *   - 8 tools × 3 statuses (Detected / NotInstalled / AccessDenied)
 *     each render the right chip + CTA + reason text.
 *   - Auto-configure click on a Detected card calls
 *     `setup_wizard_auto_configure_mcp` with the tool id.
 *   - Health-check polling transitions Detected → Configuring →
 *     Waiting for restart → Connected once `mcp_server_handshake`
 *     answers true.
 *   - 30s timeout case: handshake stays false → grid shows
 *     "Restart [tool] to finish setup" + Retry CTA.
 *   - Retry CTA on timeout re-arms polling.
 *   - Get [tool] click on NotInstalled fires openExternal with the
 *     tool's install URL.
 *   - Display order honors Detected-first then market rank.
 *   - Honesty: a thrown auto-configure surfaces error text + does
 *     NOT advance to Connected.
 *
 * The test mocks `personalAgentsScanAll`, `setupWizardAutoConfigureMcp`,
 * `mcpServerHandshake`, and `openExternal` from `@/lib/tauri`, plus
 * `logEvent` from `@/lib/telemetry`. We use vitest fake timers to
 * advance the 3s poll interval + 30s ceiling without real wall-clock
 * waits — keeps the suite under 1s wall-clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";

import type {
  PersonalAgentSummary,
  PersonalAgentDetectionStatus,
} from "../src/lib/tauri";

// --- Hoisted mocks (vi.mock factories see these at module-load) ---
const mocks = vi.hoisted(() => ({
  personalAgentsScanAll: vi.fn(async (): Promise<PersonalAgentSummary[]> => []),
  setupWizardAutoConfigureMcp: vi.fn(async (_id: string) => ({
    ok: true,
    file_written: "~/.mock/mcp.json",
    restart_required: true,
    error: null as string | null,
  })),
  mcpServerHandshake: vi.fn(async (_id: string) => false),
  openExternal: vi.fn(async (_url: string) => {}),
  logEvent: vi.fn(async (_e: string, _p: Record<string, unknown>) => {}),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tauri")>();
  return {
    ...actual,
    personalAgentsScanAll: mocks.personalAgentsScanAll,
    setupWizardAutoConfigureMcp: mocks.setupWizardAutoConfigureMcp,
    mcpServerHandshake: mocks.mcpServerHandshake,
    openExternal: mocks.openExternal,
  };
});

vi.mock("@/lib/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telemetry")>();
  return {
    ...actual,
    logEvent: mocks.logEvent,
  };
});

import AIToolDetectionGrid, {
  AI_TOOL_CATALOG,
} from "../src/components/onboarding/AIToolDetectionGrid";
import { useStore } from "../src/lib/store";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Build a PersonalAgentSummary for a given tool + status. The grid
 *  joins by `source` so we anchor on the catalog's `sourceKey`. */
function summary(
  toolId: string,
  status: PersonalAgentDetectionStatus,
): PersonalAgentSummary {
  const tool = AI_TOOL_CATALOG.find((t) => t.id === toolId);
  if (!tool) throw new Error(`unknown tool ${toolId}`);
  return {
    source: tool.sourceKey,
    detected: status.kind === "installed",
    home_path: "/mock/home",
    conversation_count: status.kind === "installed" ? 3 : 0,
    status,
  };
}

/** Seed the scan mock with one summary per tool, defaulting to
 *  not_installed; override specific tools via the partial map. */
function seedScan(
  overrides: Partial<Record<string, PersonalAgentDetectionStatus>> = {},
): void {
  const rows = AI_TOOL_CATALOG.map((t) =>
    summary(t.id, overrides[t.id] ?? { kind: "not_installed" }),
  );
  mocks.personalAgentsScanAll.mockReset();
  mocks.personalAgentsScanAll.mockResolvedValue(rows);
}

/** Wait for the grid loading shimmer to fall off so subsequent
 *  queries see the actual cards. */
async function waitForGridReady(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("ai-tool-detection-grid")).toHaveAttribute(
      "data-state",
      "ready",
    ),
  );
}

beforeEach(() => {
  // Reset every mock so cross-test contamination can't paper over a
  // genuinely missing call.
  mocks.personalAgentsScanAll.mockReset();
  mocks.setupWizardAutoConfigureMcp.mockReset();
  mocks.mcpServerHandshake.mockReset();
  mocks.openExternal.mockReset();
  mocks.logEvent.mockReset();
  mocks.setupWizardAutoConfigureMcp.mockResolvedValue({
    ok: true,
    file_written: "~/.mock/mcp.json",
    restart_required: true,
    error: null,
  });
  mocks.mcpServerHandshake.mockResolvedValue(false);
  mocks.openExternal.mockResolvedValue(undefined);
  // Reset toast queue so we can assert per-test.
  useStore.setState((s) => ({ ui: { ...s.ui, toasts: [] } }));
});

afterEach(() => {
  cleanup();
  // Defensive: any test that opted into fake timers must restore real
  // timers before the next test runs. Tests that never enabled fakes
  // are unaffected (vi.useRealTimers is a no-op in that case).
  vi.useRealTimers();
});

// ============================================================================
// Catalog sanity — guards the 8-tool requirement at compile time
// ============================================================================
describe("W1.2 catalog", () => {
  it("ships exactly 8 tools in market-rank order", () => {
    expect(AI_TOOL_CATALOG).toHaveLength(8);
    const ids = AI_TOOL_CATALOG.map((t) => t.id);
    expect(ids).toEqual([
      "cursor",
      "claude-code",
      "codex",
      "windsurf",
      "devin",
      "replit",
      "apple-intelligence",
      "ms-copilot",
    ]);
  });
});

// ============================================================================
// 8 tools × 3 statuses — render matrix
// ============================================================================
describe.each(AI_TOOL_CATALOG)("W1.2 render — $name ($id)", (tool) => {
  it(`Detected (installed) → renders chip + Auto-configure CTA`, async () => {
    seedScan({ [tool.id]: { kind: "installed" } });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    const card = screen.getByTestId(`grid-card-${tool.id}`);
    expect(card).toHaveAttribute("data-phase", "idle");
    // Detected chip.
    expect(card.querySelector('[data-testid="grid-chip-installed"]')).not.toBeNull();
    // Auto-configure CTA labeled to the tool.
    const cta = screen.getByTestId(`grid-cta-auto-configure-${tool.id}`);
    expect(cta).toHaveAttribute("aria-label", `Auto-configure ${tool.name}`);
  });

  it(`NotInstalled → renders chip + Get CTA pointing at install URL`, async () => {
    seedScan({ [tool.id]: { kind: "not_installed" } });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    const card = screen.getByTestId(`grid-card-${tool.id}`);
    expect(card.querySelector('[data-testid="grid-chip-not-installed"]')).not.toBeNull();
    const cta = screen.getByTestId(`grid-cta-get-${tool.id}`);
    expect(cta).toHaveAttribute("aria-label", `Get ${tool.name}`);
    // Click → openExternal fires with the catalog URL (proves the wiring
    // honestly hits R4 v1.14.3's external opener path, not a stub).
    await act(async () => {
      fireEvent.click(cta);
    });
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(tool.installUrl),
    );
  });

  it(`AccessDenied → renders denial chip + reason text + Retry CTA`, async () => {
    const reason = `EACCES on ${tool.id} dir`;
    seedScan({ [tool.id]: { kind: "access_denied", reason } });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    const card = screen.getByTestId(`grid-card-${tool.id}`);
    expect(card.querySelector('[data-testid="grid-chip-access-denied"]')).not.toBeNull();
    // Reason MUST be visible on the card — the R6 "trust collapse"
    // surface only works if users see WHY they're denied.
    expect(screen.getByTestId(`grid-card-reason-${tool.id}`)).toHaveTextContent(reason);
    // Retry CTA exists + clicking it re-runs the scan.
    const retry = screen.getByTestId(`grid-cta-retry-${tool.id}`);
    expect(retry).toHaveAttribute("aria-label", `Retry ${tool.name} detection`);
    await act(async () => {
      fireEvent.click(retry);
    });
    // Initial render scan + the retry click = at least 2 calls.
    await waitFor(() =>
      expect(mocks.personalAgentsScanAll.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });
});

// ============================================================================
// Auto-configure → handshake polling → Connected
// ============================================================================
describe("W1.2 auto-configure flow", () => {
  it("Detected → Auto-configure click invokes setup_wizard_auto_configure_mcp with tool id", async () => {
    seedScan({ cursor: { kind: "installed" } });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-cursor"));
    });
    await waitFor(() =>
      expect(mocks.setupWizardAutoConfigureMcp).toHaveBeenCalledWith("cursor"),
    );
    // Phase advances to waiting_restart (or connected on instant true).
    await waitFor(() => {
      const card = screen.getByTestId("grid-card-cursor");
      expect(["waiting_restart", "connected"]).toContain(
        card.getAttribute("data-phase"),
      );
    });
  });

  it("polls mcp_server_handshake every 3s and flips to Connected once it returns true", async () => {
    // Real timers — let the actual setInterval drive the loop. We
    // make handshake true on the first probe so the test resolves
    // immediately instead of waiting 3s wall-clock per cycle.
    seedScan({ "claude-code": { kind: "installed" } });
    mocks.mcpServerHandshake.mockResolvedValue(true);
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-claude-code"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("grid-state-connected-claude-code")).toBeInTheDocument(),
    );
    // Handshake was called with the right tool id.
    expect(mocks.mcpServerHandshake).toHaveBeenCalledWith("claude-code");
    // Telemetry fired with the W1.4 event name.
    await waitFor(() =>
      expect(mocks.logEvent).toHaveBeenCalledWith(
        "mcp_connected",
        expect.objectContaining({ tool_id: "claude-code" }),
      ),
    );
  });

  it("times out at 30s when handshake never succeeds and surfaces Restart prompt + Retry CTA", async () => {
    // Fake timers so we can blow past 30s without waiting wall-clock.
    vi.useFakeTimers();
    seedScan({ codex: { kind: "installed" } });
    mocks.mcpServerHandshake.mockResolvedValue(false);
    render(<AIToolDetectionGrid />);
    // Drain pending microtasks / timers so the initial scan resolves
    // under fake timers (waitForGridReady would hang otherwise).
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByTestId("ai-tool-detection-grid")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-codex"));
    });
    // Drain auto-configure promise + first immediate handshake probe.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    // Cross the 30s ceiling — fires timeout, stops polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 100);
    });
    expect(screen.getByTestId("grid-state-timeout-codex")).toHaveTextContent(
      /Restart Codex to finish setup/i,
    );
    // Retry CTA exists post-timeout.
    expect(
      screen.getByTestId("grid-cta-retry-handshake-codex"),
    ).toBeInTheDocument();
    // Connected MUST NOT appear — honesty contract.
    expect(screen.queryByTestId("grid-state-connected-codex")).toBeNull();
  });

  it("Retry on timeout re-arms the handshake polling loop", async () => {
    vi.useFakeTimers();
    seedScan({ windsurf: { kind: "installed" } });
    mocks.mcpServerHandshake.mockResolvedValue(false);
    render(<AIToolDetectionGrid />);
    // Drain initial scan microtasks under fake timers.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByTestId("ai-tool-detection-grid")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-windsurf"));
    });
    // Drain auto-configure resolution + first immediate handshake probe.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    // Cross the 30s ceiling so the timeout fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 100);
    });
    expect(
      screen.getByTestId("grid-cta-retry-handshake-windsurf"),
    ).toBeInTheDocument();
    // Flip handshake to truth and click Retry. First probe is
    // microtask-immediate, so a single drain reaches Connected.
    mocks.mcpServerHandshake.mockResolvedValue(true);
    const callsBefore = mocks.mcpServerHandshake.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-retry-handshake-windsurf"));
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(mocks.mcpServerHandshake.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(
      screen.getByTestId("grid-state-connected-windsurf"),
    ).toBeInTheDocument();
  });

  it("auto-configure that returns ok=false surfaces the error and does NOT poll handshake", async () => {
    seedScan({ devin: { kind: "installed" } });
    mocks.setupWizardAutoConfigureMcp.mockResolvedValueOnce({
      ok: false,
      file_written: "",
      restart_required: false,
      error: "permission denied writing ~/.devin/mcp.json",
    });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-devin"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("grid-state-error-devin")).toHaveTextContent(
        /permission denied/i,
      ),
    );
    // No handshake call — we did NOT lie and pretend things were OK.
    expect(mocks.mcpServerHandshake).not.toHaveBeenCalled();
    // Connected MUST NOT appear.
    expect(screen.queryByTestId("grid-state-connected-devin")).toBeNull();
  });

  it("auto-configure that THROWS surfaces the thrown message + leaves card in error phase", async () => {
    seedScan({ replit: { kind: "installed" } });
    mocks.setupWizardAutoConfigureMcp.mockRejectedValueOnce(
      new Error("rust panic: not implemented"),
    );
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId("grid-cta-auto-configure-replit"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("grid-state-error-replit")).toHaveTextContent(
        /not implemented/i,
      ),
    );
    expect(screen.getByTestId("grid-card-replit")).toHaveAttribute(
      "data-phase",
      "error",
    );
  });
});

// ============================================================================
// Display order
// ============================================================================
describe("W1.2 display order", () => {
  it("places detected tools first, then remaining tools by market rank", async () => {
    seedScan({
      // Detect codex (rank 3) + replit (rank 6) — they should jump to
      // the top in market-rank order (codex first).
      codex: { kind: "installed" },
      replit: { kind: "installed" },
    });
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    const cards = screen
      .getAllByTestId(/^grid-card-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(cards.slice(0, 2)).toEqual([
      "grid-card-codex",
      "grid-card-replit",
    ]);
    // Undetected tail: cursor → claude-code → windsurf → devin →
    // apple-intelligence → ms-copilot (codex + replit removed).
    expect(cards.slice(2)).toEqual([
      "grid-card-cursor",
      "grid-card-claude-code",
      "grid-card-windsurf",
      "grid-card-devin",
      "grid-card-apple-intelligence",
      "grid-card-ms-copilot",
    ]);
  });
});

// ============================================================================
// Scan failure surface — honest error, no silent empty grid
// ============================================================================
describe("W1.2 scan failure", () => {
  it("a thrown personalAgentsScanAll renders an error block + Retry button (NOT an empty grid)", async () => {
    mocks.personalAgentsScanAll.mockReset();
    mocks.personalAgentsScanAll.mockRejectedValue(new Error("ipc bridge dead"));
    render(<AIToolDetectionGrid />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-tool-detection-grid")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(screen.getByText(/ipc bridge dead/i)).toBeInTheDocument();
    // Retry exists.
    expect(screen.getByTestId("ai-tool-detection-grid-retry")).toBeInTheDocument();
  });
});

// ============================================================================
// A11y — Esc bubbles to onEscape, region landmark labelled
// ============================================================================
describe("W1.2 a11y", () => {
  it("Esc on the grid section calls onEscape so the route can navigate back", async () => {
    seedScan();
    const onEscape = vi.fn();
    render(<AIToolDetectionGrid onEscape={onEscape} />);
    await waitForGridReady();
    fireEvent.keyDown(screen.getByTestId("ai-tool-detection-grid"), {
      key: "Escape",
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("grid renders as a labelled region for screen readers", async () => {
    seedScan();
    render(<AIToolDetectionGrid />);
    await waitForGridReady();
    expect(screen.getByRole("region", { name: /Connect an AI tool/i })).toBeInTheDocument();
  });
});

// Polling constants must match the component (kept private there to
// avoid leaking the timing into store/contract surface). If the
// component changes these, the timing-driven tests break loudly —
// which is the desired behavior.
const HANDSHAKE_POLL_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
// === end v1.15.0 wave 1.2 ===
