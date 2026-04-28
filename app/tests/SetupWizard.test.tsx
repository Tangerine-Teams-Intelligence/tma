// === wave 11 ===
/**
 * v1.10.2 — SetupWizard component tests.
 *
 * Coverage:
 *   1. Step 1 (welcome) renders + Skip flips persisted state.
 *   2. Step 2 (detect) loads detection result + recommends a channel.
 *   3. Step 3 (configure / MCP) auto-configure path writes file.
 *   4. Step 3 manual snippet path renders the JSON.
 *   5. Step 4 (test) shows success result + continue button enables.
 *   6. Step 4 failure path shows retry + pick-different.
 *   7. Step 5 (done) flips channelReady to true.
 *
 * The SetupWizard calls Tauri commands — outside Tauri, the lib/tauri.ts
 * wrappers fall back to mocks (channel test returns ok in mock). We mock
 * a few of them per-test where we need specific shapes (e.g. detection
 * with no editors so the recommendation card lands on Ollama).
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import { SetupWizard } from "../src/components/SetupWizard";
import { useStore } from "../src/lib/store";

// Mock the entire tauri lib's wave-11 exports. The other exports stay
// real so unrelated AppShell wiring keeps working in this isolated test.
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
      response_preview: "Tangerine LLM channel test OK",
      latency_ms: 1234,
      error: null,
    }),
    setupWizardInstallOllamaHint: vi.fn().mockResolvedValue({
      os: "windows",
      url: "https://ollama.com/download/windows",
      cli: null,
      note: "test",
    }),
    setupWizardPersistState: vi.fn().mockResolvedValue({
      completed_at: "2026-04-27T00:00:00Z",
      channel_ready: true,
      primary_channel: "mcp_sampling/cursor",
      skipped: false,
    }),
  };
});

beforeEach(() => {
  // Reset wave-11 store slice on every test so cross-test contamination
  // (a finished wizard leaving channel_ready true) can't mask bugs.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      setupWizardOpen: false,
      setupWizardChannelReady: false,
      setupWizardSkipped: false,
      setupWizardPrimaryChannel: null,
      setupWizardDismissedThisSession: false,
    },
  }));
  vi.clearAllMocks();
});

describe("SetupWizard", () => {
  it("renders step 1 (welcome) when first opened", () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    expect(screen.getByTestId("setup-wizard-step-welcome")).toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-welcome-continue")).toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-welcome-skip")).toBeInTheDocument();
  });

  it("Skip from welcome flips setupWizardSkipped + closes", () => {
    const onClose = vi.fn();
    render(<SetupWizard open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-skip"));
    expect(useStore.getState().ui.setupWizardSkipped).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking Let's go advances to detect + loads detection results", async () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    // The detect step mounts immediately, then the detection promise
    // resolves and the results render.
    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-step-detect")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-channel-mcp-cursor")).toBeInTheDocument();
    });
    // Auto-pre-selected the recommended channel.
    expect(
      screen.getByTestId("setup-wizard-channel-mcp-cursor").getAttribute("data-selected"),
    ).toBe("true");
  });

  it("auto-configure writes the MCP file and shows the restart hint", async () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-configure")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-mcp-written")).toBeInTheDocument(),
    );
    // Continue button only appears once the write completes successfully.
    expect(screen.getByTestId("setup-wizard-mcp-restarted")).toBeInTheDocument();
  });

  it("manual snippet toggle reveals the JSON snippet", async () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-snippet-toggle"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-snippet-toggle"));
    expect(screen.getByTestId("setup-wizard-mcp-snippet")).toBeInTheDocument();
    expect(screen.getByText(/TANGERINE_SAMPLING_BRIDGE/)).toBeInTheDocument();
  });

  it("test step shows success + enables continue when channel works", async () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-auto"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-restarted"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-restarted"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-test")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-test-ok")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Tangerine LLM channel test OK/)).toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-test-continue")).toBeInTheDocument();
  });

  it("test failure surfaces retry + pick-different buttons", async () => {
    // Override mock for this one test — channel fails.
    const tauri = await import("../src/lib/tauri");
    (tauri.setupWizardTestChannel as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        channel_used: "primary_unreachable",
        response_preview: "",
        latency_ms: 0,
        error: "MCP sampler not registered",
      });

    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-auto"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-restarted"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-restarted"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-test-fail")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("setup-wizard-test-retry")).toBeInTheDocument();
    expect(screen.getByTestId("setup-wizard-test-pick-different")).toBeInTheDocument();
  });

  it("step 5 (done) flips setupWizardChannelReady + records primary_channel", async () => {
    render(<SetupWizard open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-auto"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-restarted"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-restarted"));
    await waitFor(() => screen.getByTestId("setup-wizard-test-ok"));
    fireEvent.click(screen.getByTestId("setup-wizard-test-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-done")).toBeInTheDocument(),
    );
    // Wait for the persist state effect to flip the store.
    await waitFor(() => {
      expect(useStore.getState().ui.setupWizardChannelReady).toBe(true);
    });
    expect(useStore.getState().ui.setupWizardPrimaryChannel).toBe(
      "mcp_sampling/cursor",
    );
  });

  it("Done CTA closes the wizard", async () => {
    const onClose = vi.fn();
    render(<SetupWizard open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-channel-mcp-cursor"));
    fireEvent.click(screen.getByTestId("setup-wizard-detect-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-auto"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-auto"));
    await waitFor(() => screen.getByTestId("setup-wizard-mcp-restarted"));
    fireEvent.click(screen.getByTestId("setup-wizard-mcp-restarted"));
    await waitFor(() => screen.getByTestId("setup-wizard-test-ok"));
    fireEvent.click(screen.getByTestId("setup-wizard-test-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-done-close"));
    fireEvent.click(screen.getByTestId("setup-wizard-done-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not render when open=false", () => {
    const { container } = render(
      <SetupWizard open={false} onClose={() => undefined} />,
    );
    expect(container.querySelector('[data-testid="setup-wizard"]')).toBeNull();
  });

  it("close button (X) calls onClose", () => {
    const onClose = vi.fn();
    render(<SetupWizard open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("setup-wizard-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-opening (open transition) resets to step 1", async () => {
    const { rerender } = render(
      <SetupWizard open={true} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getByTestId("setup-wizard-welcome-continue"));
    await waitFor(() => screen.getByTestId("setup-wizard-step-detect"));
    // Close + re-open
    rerender(<SetupWizard open={false} onClose={() => undefined} />);
    rerender(<SetupWizard open={true} onClose={() => undefined} />);
    expect(screen.getByTestId("setup-wizard-step-welcome")).toBeInTheDocument();
  });
});

// Suppress useEffect cleanup chatter in some test runners.
afterEachShim();
function afterEachShim() {
  if (typeof act === "function") {
    // no-op — kept for grep parity with the wave-10 test file format.
  }
}
// === end wave 11 ===
