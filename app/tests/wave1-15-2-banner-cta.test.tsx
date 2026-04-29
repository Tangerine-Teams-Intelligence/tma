// === v1.15.2 Fix #3 — banner CTA + handshake-aware visibility ===
/**
 * Coverage:
 *   - Banner renders when `setupWizardChannelReady === false` (no
 *     handshake probe — the latch alone is honest).
 *   - Click on "立即配置" / "Set up now" flips `setupWizardOpen` AND
 *     emits `setup_wizard_banner_clicked` telemetry (CTR signal).
 *   - Banner hidden when `setupWizardChannelReady === true` AND no
 *     primary mcp channel (we have no probe — trust the latch).
 *   - Banner hidden when `setupWizardChannelReady === true` AND the
 *     mcp handshake comes back ok.
 *   - Banner RE-APPEARS when `setupWizardChannelReady === true` but
 *     the mcp handshake comes back broken (the dogfood bug — latch
 *     and reality drift apart).
 *   - X-dismiss hides banner THIS session (`dismissedThisSession`
 *     flips). The flag is NOT persisted — cold launch resets it so a
 *     still-broken channel keeps nagging.
 *
 * Wiring rationale:
 *   We mock `@/lib/tauri::mcpServerHandshake` per-suite so the polling
 *   probe inside the banner has a deterministic answer. `logEvent` is
 *   mocked so we can assert exact event names + payload shape without
 *   round-tripping through the Rust telemetry sink.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

// ----------------------------------------------------------------------------
// Mocks (must be declared before the SUT import)
// ----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  mcpServerHandshake: vi.fn(async (_id: string) => false),
  logEvent: vi.fn(async (_e: string, _p: Record<string, unknown>) => {}),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tauri")>();
  return {
    ...actual,
    mcpServerHandshake: mocks.mcpServerHandshake,
  };
});

vi.mock("@/lib/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telemetry")>();
  return {
    ...actual,
    logEvent: mocks.logEvent,
  };
});

import { SetupWizardBanner } from "../src/components/SetupWizardBanner";
import { useStore } from "../src/lib/store";

// ----------------------------------------------------------------------------
// Setup
// ----------------------------------------------------------------------------

beforeEach(() => {
  mocks.mcpServerHandshake.mockReset();
  mocks.mcpServerHandshake.mockResolvedValue(false);
  mocks.logEvent.mockReset();
  mocks.logEvent.mockResolvedValue(undefined);
  // Pristine slice — both flags off, no primary channel selected. Mirrors
  // a fresh install that never finished the wizard.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      setupWizardChannelReady: false,
      setupWizardDismissedThisSession: false,
      setupWizardOpen: false,
      setupWizardPrimaryChannel: null,
    },
  }));
});

afterEach(() => {
  cleanup();
});

// ----------------------------------------------------------------------------
// Specs
// ----------------------------------------------------------------------------

describe("v1.15.2 Fix #3 — SetupWizardBanner CTA + handshake gating", () => {
  it("renders when channel not ready (no probe needed — latch is honest)", () => {
    render(<SetupWizardBanner />);
    expect(screen.getByTestId("setup-wizard-banner")).toBeInTheDocument();
    // No primary channel set → no handshake probe should be issued. The
    // banner is showing because we KNOW the channel isn't set up.
    expect(mocks.mcpServerHandshake).not.toHaveBeenCalled();
  });

  it("click '立即配置' opens the SetupWizard AND emits CTR telemetry", () => {
    render(<SetupWizardBanner />);
    fireEvent.click(screen.getByTestId("setup-wizard-banner-open"));

    // 1. Wizard mount — the on-demand <SetupWizard open={setupWizardOpen} />
    //    in AppShell honors this flag.
    expect(useStore.getState().ui.setupWizardOpen).toBe(true);

    // 2. CTR event fires with the captured flag + primary channel snapshot.
    const clickedCalls = mocks.logEvent.mock.calls.filter(
      (c) => c[0] === "setup_wizard_banner_clicked",
    );
    expect(clickedCalls.length).toBe(1);
    expect(clickedCalls[0][1]).toEqual({
      channel_ready_flag: false,
      primary_channel: null,
    });

    // 3. The legacy wave-11 funnel event still fires for back-compat with
    //    the existing analytics dashboards.
    const openCalls = mocks.logEvent.mock.calls.filter(
      (c) => c[0] === "setup_wizard_banner_open",
    );
    expect(openCalls.length).toBe(1);
  });

  it("hides when channel ready and no primary mcp channel (trust the latch)", () => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        setupWizardChannelReady: true,
        // ollama / browser_ext / null — no frontend probe available.
        setupWizardPrimaryChannel: "ollama",
      },
    }));
    const { container } = render(<SetupWizardBanner />);
    expect(
      container.querySelector('[data-testid="setup-wizard-banner"]'),
    ).toBeNull();
    // No mcp tool → we never probe (HFB rule: no fake "broken" state
    // when we have no honest way to verify).
    expect(mocks.mcpServerHandshake).not.toHaveBeenCalled();
  });

  it("hides when channel ready AND mcp handshake ok", async () => {
    mocks.mcpServerHandshake.mockResolvedValue(true);
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        setupWizardChannelReady: true,
        setupWizardPrimaryChannel: "mcp_sampling/cursor",
      },
    }));
    const { container } = render(<SetupWizardBanner />);
    // First render: probe in flight → optimistically hidden so we don't
    // flash the banner on every cold launch while the bridge wakes up.
    expect(
      container.querySelector('[data-testid="setup-wizard-banner"]'),
    ).toBeNull();
    await waitFor(() =>
      expect(mocks.mcpServerHandshake).toHaveBeenCalledWith("cursor"),
    );
    // Probe came back ok → banner stays hidden.
    expect(
      container.querySelector('[data-testid="setup-wizard-banner"]'),
    ).toBeNull();
  });

  it("RE-APPEARS when channel-ready latch is true but mcp handshake is broken", async () => {
    mocks.mcpServerHandshake.mockResolvedValue(false);
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        setupWizardChannelReady: true,
        setupWizardPrimaryChannel: "mcp_sampling/claude_desktop",
      },
    }));
    render(<SetupWizardBanner />);
    // Probe lands → handshakeOk = false → banner mounts.
    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-banner")).toBeInTheDocument();
    });
    expect(mocks.mcpServerHandshake).toHaveBeenCalledWith("claude_desktop");
  });

  it("X-dismiss hides this session; cold-launch reset rule preserved (no persistence)", () => {
    render(<SetupWizardBanner />);
    expect(screen.getByTestId("setup-wizard-banner")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("setup-wizard-banner-dismiss"));
    // Session-scoped flag flipped — banner gone for this render tree.
    expect(useStore.getState().ui.setupWizardDismissedThisSession).toBe(true);

    // Re-render after dismiss → still hidden.
    cleanup();
    const { container: after } = render(<SetupWizardBanner />);
    expect(
      after.querySelector('[data-testid="setup-wizard-banner"]'),
    ).toBeNull();

    // Simulate cold-launch: the persist layer drops session flags
    // (see store.ts wave-11 partialize block — `setupWizardDismissedThisSession`
    // is intentionally not in the persisted set), so a fresh boot resets
    // the flag and the still-broken channel keeps nagging.
    act(() => {
      useStore.setState((s) => ({
        ui: { ...s.ui, setupWizardDismissedThisSession: false },
      }));
    });
    cleanup();
    render(<SetupWizardBanner />);
    expect(screen.getByTestId("setup-wizard-banner")).toBeInTheDocument();
  });
});
// === end v1.15.2 Fix #3 ===
