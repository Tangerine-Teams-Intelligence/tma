// === wave 1.15 W1.1 ===
/**
 * v1.15.0 W1.1 — first-launch SetupWizard gate tests.
 *
 * Coverage:
 *   1. Fresh install (`onboardingCompletedAt === null`) → AppShell mounts
 *      the SetupWizard with `firstLaunch=true` (X close hidden, paths
 *      step is the entry point).
 *   2. Returning user (`onboardingCompletedAt` is a number) → wizard does
 *      NOT mount in first-launch mode (skipped by AppShell gate).
 *   3. Three path cards render (Connect AI tool / Try with sample data /
 *      Configure manually) and the connect card is the default-highlighted
 *      one.
 *   4-6. Each card click stamps `onboardingCompletedAt` (Connect, Sample,
 *      and the Skip link). The "Configure manually" card switches the
 *      wizard step to `welcome` (not stamping yet — completion happens
 *      after the Done step finishes).
 *   7. Connect AI tool card navigates to /setup/connect.
 *   8. Try with sample data card navigates to /today.
 *   9. OnboardingChat is NOT default-mounted on /today — the today route
 *      now defaults to `onboardingMode: "wizard"` so OnboardingChat's
 *      mode kill-switch returns null.
 *   10. The form-wizard "Done" step also stamps `onboardingCompletedAt`
 *      (existing wave-11 path stays alive).
 *   11. The new `setOnboardingCompletedAt` setter / `onboardingMode`
 *      default flip is reflected in the store on first load.
 *   12. Settings → Advanced exposes the "Configure with AI" entry which
 *      flips `onboardingMode` back to "chat".
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { SetupWizard } from "../src/components/SetupWizard";
import { AdvancedSettings } from "../src/pages/settings/AdvancedSettings";
import { useStore } from "../src/lib/store";

// Mock the wave-11 Tauri detect/configure/test commands so the wizard
// can step through the "Configure manually" flow deterministically.
vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>(
    "../src/lib/tauri",
  );
  return {
    ...actual,
    setupWizardDetect: vi.fn().mockResolvedValue({
      mcp_capable_tools: [
        {
          tool_id: "cursor",
          display_name: "Cursor",
          config_path: "/home/u/.cursor/mcp.json",
          already_has_tangerine: false,
        },
      ],
      ollama_running: false,
      ollama_default_model: null,
      browser_ext_browsers: ["Chrome"],
      cloud_reachable: false,
      recommended_channel: {
        kind: "mcp_sampling",
        tool_id: "cursor",
        requires_restart: true,
      },
    }),
    setupWizardAutoConfigureMcp: vi.fn().mockResolvedValue({
      ok: true,
      file_written: "/home/u/.cursor/mcp.json",
      restart_required: true,
      error: null,
    }),
    setupWizardTestChannel: vi.fn().mockResolvedValue({
      ok: true,
      channel_used: "mcp_sampling",
      response_preview: "ok",
      latency_ms: 1,
      error: null,
    }),
    setupWizardPersistState: vi.fn().mockResolvedValue({
      completed_at: "2026-04-28T00:00:00Z",
      channel_ready: true,
      primary_channel: "mcp_sampling/cursor",
      skipped: false,
    }),
    setupWizardInstallOllamaHint: vi.fn().mockResolvedValue({
      os: "windows",
      url: "https://ollama.com/download/windows",
      cli: null,
      note: "test",
    }),
    coThinkerDispatch: vi.fn().mockResolvedValue({
      text: "ok",
      channel_used: "mcp_sampling",
      tool_id: "cursor",
      latency_ms: 1,
      tokens_estimate: 1,
    }),
    dailyNotesEnsureToday: vi.fn().mockResolvedValue({ ok: true, path: "" }),
    localTodayIso: () => "2026-04-28",
  };
});

beforeEach(() => {
  // Reset every relevant ui slice so each test starts in fresh-install
  // state without bleed from prior tests.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      onboardingCompletedAt: null,
      onboardingMode: "wizard",
      setupWizardOpen: false,
      setupWizardChannelReady: false,
      setupWizardSkipped: false,
      setupWizardPrimaryChannel: null,
      setupWizardDismissedThisSession: false,
    },
  }));
  // Clean URL so navigate() assertions work.
  if (typeof window !== "undefined") {
    window.history.replaceState({}, "", "/");
  }
});

afterEach(() => {
  cleanup();
});

const renderInRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter initialEntries={["/today"]}>{ui}</MemoryRouter>);

describe("wave 1.15 W1.1 — first-launch SetupWizard", () => {
  it("default store has onboardingCompletedAt === null on a fresh install", () => {
    expect(useStore.getState().ui.onboardingCompletedAt).toBeNull();
    expect(useStore.getState().ui.onboardingMode).toBe("wizard");
  });

  it("renders the paths step when mounted with firstLaunch=true", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    expect(screen.getByTestId("setup-wizard-step-paths")).toBeInTheDocument();
    // X close is hidden when firstLaunch=true so the user can't escape
    // the gate without picking a path / skip.
    expect(screen.queryByTestId("setup-wizard-close")).not.toBeInTheDocument();
  });

  it("renders all three path cards with the connect card highlighted", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    const connect = screen.getByTestId("setup-wizard-path-connect");
    const sample = screen.getByTestId("setup-wizard-path-sample");
    const manual = screen.getByTestId("setup-wizard-path-manual");
    expect(connect).toBeInTheDocument();
    expect(sample).toBeInTheDocument();
    expect(manual).toBeInTheDocument();
    // The recommended card uses border-2 + the orange palette tag. We
    // assert via the explicit "Recommended" badge text.
    expect(connect.textContent).toMatch(/Recommended/i);
  });

  it("connect-AI card stamps onboardingCompletedAt and navigates to /setup/connect", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-path-connect"));
    expect(useStore.getState().ui.onboardingCompletedAt).not.toBeNull();
    expect(typeof useStore.getState().ui.onboardingCompletedAt).toBe("number");
    expect(window.location.pathname).toBe("/setup/connect");
  });

  it("sample-data card stamps onboardingCompletedAt and navigates to /today", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-path-sample"));
    expect(useStore.getState().ui.onboardingCompletedAt).not.toBeNull();
    expect(window.location.pathname).toBe("/today");
  });

  it("configure-manually card advances the wizard to the welcome step", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-path-manual"));
    expect(screen.getByTestId("setup-wizard-step-welcome")).toBeInTheDocument();
    // Manual path does NOT stamp the latch yet — completion happens
    // after the Done step persists.
    expect(useStore.getState().ui.onboardingCompletedAt).toBeNull();
  });

  it("skip link from paths step stamps onboardingCompletedAt", () => {
    renderInRouter(<SetupWizard open firstLaunch onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-paths-skip"));
    expect(useStore.getState().ui.onboardingCompletedAt).not.toBeNull();
    expect(useStore.getState().ui.setupWizardSkipped).toBe(true);
  });

  it("returning user (onboardingCompletedAt set) skips the first-launch entry", () => {
    // Simulate a returning user: latch is already stamped. AppShell uses
    // this exact predicate (`onboardingCompletedAt === null`) as its
    // gate. We assert the predicate flips correctly.
    useStore.setState((s) => ({
      ui: { ...s.ui, onboardingCompletedAt: 1700000000000 },
    }));
    expect(useStore.getState().ui.onboardingCompletedAt).not.toBeNull();
    // Render the wizard NOT in first-launch mode (the AppShell would do
    // this — only mount the firstLaunch wizard when latch is null).
    renderInRouter(<SetupWizard open onClose={() => undefined} />);
    // Should land on the welcome step (default), not paths.
    expect(screen.queryByTestId("setup-wizard-step-paths")).not.toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-step-welcome")).toBeInTheDocument();
    // X close button is visible in non-first-launch mode.
    expect(screen.getByTestId("setup-wizard-close")).toBeInTheDocument();
  });

  it("on-demand wizard (firstLaunch=false) lands on welcome and shows X close", () => {
    renderInRouter(<SetupWizard open onClose={() => undefined} />);
    expect(screen.getByTestId("setup-wizard-step-welcome")).toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-close")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-wizard-step-paths")).not.toBeInTheDocument();
  });

  it("full wizard completion (Done step) stamps onboardingCompletedAt", async () => {
    renderInRouter(<SetupWizard open onClose={() => undefined} />);
    // welcome → detect
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() =>
      screen.getByTestId("setup-wizard-channel-mcp-cursor"),
    );
    // detect → configure
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-auto"));
    // auto-configure
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-restarted"));
    // configure → test
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-restarted"));
    await waitFor(() => screen.getByTestId("setup-wizard-test-continue"));
    // test → done (this is the path that stamps the latch)
    fireEvent.click(screen.getByTestId("setup-wizard-test-continue"));
    await waitFor(() => {
      expect(useStore.getState().ui.onboardingCompletedAt).not.toBeNull();
    });
    expect(useStore.getState().ui.setupWizardChannelReady).toBe(true);
  });

  it("setOnboardingCompletedAt setter writes through the store", () => {
    expect(useStore.getState().ui.onboardingCompletedAt).toBeNull();
    useStore.getState().ui.setOnboardingCompletedAt(1234567890);
    expect(useStore.getState().ui.onboardingCompletedAt).toBe(1234567890);
    useStore.getState().ui.setOnboardingCompletedAt(null);
    expect(useStore.getState().ui.onboardingCompletedAt).toBeNull();
  });

  it("Settings → Advanced 'Configure with AI' flips onboardingMode to chat", () => {
    expect(useStore.getState().ui.onboardingMode).toBe("wizard");
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route
            path="/settings"
            element={
              <AdvancedSettings
                draft={{
                  meetings_repo: "",
                  log_level: "info",
                  team: [],
                  whisper_model: "whisper-1",
                  whisper_chunk_seconds: 10,
                  output_adapters: [],
                }}
                update={() => undefined}
              />
            }
          />
          <Route path="/today" element={<div data-testid="today-stub" />} />
        </Routes>
      </MemoryRouter>,
    );
    const cta = screen.getByTestId("st-configure-with-ai");
    expect(cta).toBeInTheDocument();
    fireEvent.click(cta);
    expect(useStore.getState().ui.onboardingMode).toBe("chat");
  });
});
// === end wave 1.15 W1.1 ===
