// === v1.15.2 fix-6 ===
/**
 * v1.15.2 fix-6 — Settings → AI tools tab MERGE tests.
 *
 * Pre-fix the Settings → AI tools tab showed only the wave-11 "Primary AI
 * tool" picker (Cursor / Claude Code / etc.), while the v1.15 8-tool
 * capture grid (Cursor / Claude Code / Codex / Windsurf / Devin / Replit
 * / Apple Intelligence / MS Copilot) lived behind 显示高级设置 →
 * 个人 AI 工具. v1.15.1 dogfood confirmed two competing truths confuse
 * users. fix-6 merges them into ONE surface.
 *
 * Coverage:
 *   1. The merged tab renders BOTH "Primary channel" + "Capture sources"
 *      sections with all expected rows.
 *   2. Clicking a Primary tool card writes `primaryAITool` in the store
 *      (the wave-11 setter is preserved).
 *   3. `setupWizardPrimaryChannel` is NOT touched by this picker — only
 *      SetupWizard writes that key, and the merged tab leaves it alone
 *      so the wave-11 wizard test (which asserts the wizard sets it)
 *      keeps passing.
 *   4. Toggling a capture source row flips `personalAgentsEnabled` in
 *      the store via `personalAgentsSetWatcher`.
 *   5. The advanced-settings tab list does NOT include a separate
 *      "Personal Agents" tab — the entry is gone from ADVANCED_TABS so
 *      the user only sees one AI-tools surface.
 *   6. The legacy wave-11 layout's distinguishing copy ("Co-thinker uses
 *      this AI to think. Tangerine borrows your subscription") is NOT
 *      rendered. The new "Primary channel" copy replaces it.
 */

import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// --- Hoisted mocks for the personal-agents bridge + AI-tool detection ---
const mocks = vi.hoisted(() => ({
  personalAgentsScanAll: vi.fn(),
  personalAgentsGetSettings: vi.fn(),
  personalAgentsSetWatcher: vi.fn(),
  detectAITools: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tauri")>();
  return {
    ...actual,
    personalAgentsScanAll: mocks.personalAgentsScanAll,
    personalAgentsGetSettings: mocks.personalAgentsGetSettings,
    personalAgentsSetWatcher: mocks.personalAgentsSetWatcher,
    detectAITools: mocks.detectAITools,
  };
});

import { AIToolsSettings } from "../src/pages/settings/AIToolsSettings";
import Settings from "../src/pages/settings/Settings";
import { useStore } from "../src/lib/store";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function defaultSettings() {
  return {
    cursor: false,
    claude_code: false,
    codex: false,
    windsurf: false,
    devin: false,
    replit: false,
    apple_intelligence: false,
    ms_copilot: false,
    last_sync_at: null,
  };
}

function defaultScan() {
  return [
    { source: "cursor", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "claude-code", detected: true, home_path: "/mock", conversation_count: 55, status: { kind: "installed" as const } },
    { source: "codex", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "windsurf", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "devin", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "replit", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "apple-intelligence", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
    { source: "ms-copilot", detected: false, home_path: "/mock", conversation_count: 0, status: { kind: "not_installed" as const } },
  ];
}

function defaultDetectedTools() {
  // Two installed tools so the picker has something to render and
  // we can verify selection switches between them.
  return [
    {
      id: "cursor",
      name: "Cursor",
      status: "installed" as const,
      channel: "mcp" as const,
      install_url: null,
    },
    {
      id: "claude-code",
      name: "Claude Code",
      status: "installed" as const,
      channel: "mcp" as const,
      install_url: null,
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      status: "installed" as const,
      channel: "ide_plugin" as const,
      install_url: null,
    },
  ];
}

beforeEach(() => {
  mocks.personalAgentsScanAll.mockReset();
  mocks.personalAgentsGetSettings.mockReset();
  mocks.personalAgentsSetWatcher.mockReset();
  mocks.detectAITools.mockReset();

  mocks.personalAgentsScanAll.mockResolvedValue(defaultScan());
  mocks.personalAgentsGetSettings.mockResolvedValue(defaultSettings());
  mocks.personalAgentsSetWatcher.mockImplementation(
    async (key: string, value: boolean) => ({
      ...defaultSettings(),
      [key]: value,
    }),
  );
  mocks.detectAITools.mockResolvedValue(defaultDetectedTools());

  // Reset store keys we touch / assert.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      primaryAITool: null,
      setupWizardPrimaryChannel: null,
      showAdvancedSettings: false,
      personalAgentsEnabled: {
        cursor: false,
        claude_code: false,
        codex: false,
        windsurf: false,
        devin: false,
        replit: false,
        apple_intelligence: false,
        ms_copilot: false,
      },
    },
  }));
});

afterEach(() => {
  cleanup();
});

// ----------------------------------------------------------------------------
// Suite
// ----------------------------------------------------------------------------

describe("v1.15.2 fix-6 — merged AI tools tab", () => {
  it("renders BOTH Primary channel + Capture sources sections in one tab", async () => {
    render(<AIToolsSettings />);

    // Wait for both async data sources (detect_ai_tools + scan_all) to
    // resolve so the rows we assert on are actually mounted.
    await waitFor(() => {
      expect(
        screen.getByTestId("st-ai-primary-channel"),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("st-ai-capture-sources"),
      ).toBeInTheDocument();
    });

    // Primary channel section: the picker shows the 3 installed tools.
    await waitFor(() => {
      expect(screen.getByTestId("st-ai-pick-cursor")).toBeInTheDocument();
    });
    expect(screen.getByTestId("st-ai-pick-claude-code")).toBeInTheDocument();
    expect(screen.getByTestId("st-ai-pick-copilot")).toBeInTheDocument();

    // Capture sources section: all 8 personal-agent rows render.
    expect(
      screen.getByTestId("st-personal-agent-row-cursor"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-claude_code"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-codex"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-windsurf"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-devin"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-replit"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-apple_intelligence"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-ms_copilot"),
    ).toBeInTheDocument();
  });

  it("clicking a primary tool writes ui.primaryAITool (wave-11 setter preserved)", async () => {
    render(<AIToolsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId("st-ai-pick-claude-code")).toBeInTheDocument();
    });

    // Auto-pick effect lands on cursor (highest-priority installed tool).
    await waitFor(() => {
      expect(useStore.getState().ui.primaryAITool).toBe("cursor");
    });

    // User explicitly picks Claude Code.
    await act(async () => {
      fireEvent.click(screen.getByTestId("st-ai-pick-claude-code"));
    });
    expect(useStore.getState().ui.primaryAITool).toBe("claude-code");

    // And then Copilot.
    await act(async () => {
      fireEvent.click(screen.getByTestId("st-ai-pick-copilot"));
    });
    expect(useStore.getState().ui.primaryAITool).toBe("copilot");
  });

  it("does NOT touch setupWizardPrimaryChannel (only SetupWizard writes that key)", async () => {
    // Wave-11 invariant: SetupWizard owns setupWizardPrimaryChannel; the
    // merged tab only owns primaryAITool. Splitting these is what lets
    // the wave-11 wizard test continue to pass.
    expect(useStore.getState().ui.setupWizardPrimaryChannel).toBeNull();

    render(<AIToolsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId("st-ai-pick-cursor")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("st-ai-pick-claude-code"));
    });

    expect(useStore.getState().ui.primaryAITool).toBe("claude-code");
    // setupWizardPrimaryChannel must remain null — picker doesn't touch it.
    expect(useStore.getState().ui.setupWizardPrimaryChannel).toBeNull();
  });

  it("toggling a capture source updates personalAgentsEnabled via the bridge", async () => {
    render(<AIToolsSettings />);

    await waitFor(() => {
      expect(
        screen.getByTestId("st-personal-agent-toggle-cursor"),
      ).toBeInTheDocument();
    });

    // Initial state: off.
    expect(useStore.getState().ui.personalAgentsEnabled.cursor).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId("st-personal-agent-toggle-cursor"));
    });

    // Optimistic flip + reconcile; the watcher mock returns updated map.
    await waitFor(() => {
      expect(useStore.getState().ui.personalAgentsEnabled.cursor).toBe(true);
    });
    expect(mocks.personalAgentsSetWatcher).toHaveBeenCalledWith("cursor", true);
  });

  it("does NOT show the legacy wave-11 'GitHub Copilot Primary' standalone layout", async () => {
    render(<AIToolsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId("st-ai-tools")).toBeInTheDocument();
    });

    // The wave-11 layout's distinguishing intro copy is gone — replaced by
    // the new "Primary channel" framing. If the legacy picker were still
    // mounted, this string would appear at the top of the tab.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(
      /Co-thinker uses this AI to think\. Tangerine borrows your subscription/,
    );
    // Sanity: the new framing IS rendered.
    expect(text).toMatch(/Primary channel/);
    expect(text).toMatch(/Capture sources/);
  });

  it("Settings advanced toggle does NOT expose a separate Personal Agents tab", async () => {
    // Render the full Settings page so we can inspect the advanced tab list.
    // Flip showAdvancedSettings on so any advanced tab would be visible.
    useStore.setState((s) => ({
      ui: { ...s.ui, showAdvancedSettings: true },
    }));

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Settings />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("st-tab-ai-tools")).toBeInTheDocument();
    });

    // The advanced tabs we KEEP should still mount.
    expect(screen.getByTestId("st-tab-agi")).toBeInTheDocument();
    expect(screen.getByTestId("st-tab-adapters")).toBeInTheDocument();
    expect(screen.getByTestId("st-tab-team")).toBeInTheDocument();
    expect(screen.getByTestId("st-tab-advanced")).toBeInTheDocument();

    // The personal-agents tab MUST be gone — single source of truth lives
    // inside the merged AI tools tab now.
    expect(
      screen.queryByTestId("st-tab-personal-agents"),
    ).not.toBeInTheDocument();
  });
});
// === end v1.15.2 fix-6 ===
