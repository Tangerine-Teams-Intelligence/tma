/**
 * v1.16 Wave 4 D1 — 3-section Settings (Connect / Privacy / Sync) tests.
 *
 * Coverage targets (≥10):
 *   1. Shell renders exactly 3 tabs
 *   2. Connect section shows the 4 IDE capture rows
 *   3. Connect section shows the SourcesSettings external-sources directory
 *   4. Privacy section renders the R6 honest panel ("100% local" copy)
 *   5. Sync section shows mode picker (Solo / Team)
 *   6. Sync section shows GitHub repo URL input
 *   7. Sync section shows personal-vault toggle
 *   8. Cursor capture toggle reachable in ≤2 clicks (Connect tab → toggle)
 *   9. Cursor capture toggle update propagates to store
 *  10. Theme selector update propagates to store
 *  11. GitHub repo URL update propagates to memoryConfig
 *  12. Legacy wave-11 Primary AI tool picker is NOT mounted
 *  13. Legacy AGI tab is NOT mounted
 *  14. Legacy "Adapters" tab is NOT mounted
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Settings from "../src/pages/settings/Settings";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  // Reset persisted slices that the assertions depend on so tests are
  // order-independent.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      theme: "system",
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
      memoryConfig: { personalDirEnabled: true },
      gitMode: "init",
    },
  }));
  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  ) {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});

function renderSettings(initialEntry: string = "/settings") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Settings />
    </MemoryRouter>,
  );
}

describe("v1.16 Wave 4 D1 — 3-section Settings", () => {
  it("renders exactly 3 tabs (Connect / Privacy / Sync)", () => {
    renderSettings();
    expect(screen.getByTestId("st-tab-connect")).toBeInTheDocument();
    expect(screen.getByTestId("st-tab-privacy")).toBeInTheDocument();
    expect(screen.getByTestId("st-tab-sync")).toBeInTheDocument();
    // No legacy tabs.
    expect(screen.queryByTestId("st-tab-agi")).toBeNull();
    expect(screen.queryByTestId("st-tab-adapters")).toBeNull();
    expect(screen.queryByTestId("st-tab-team")).toBeNull();
    expect(screen.queryByTestId("st-tab-advanced")).toBeNull();
    expect(screen.queryByTestId("st-tab-ai-tools")).toBeNull();
    expect(screen.queryByTestId("st-tab-general")).toBeNull();
    expect(screen.queryByTestId("st-tab-sources")).toBeNull();
  });

  it("Connect section is the default landing tab", () => {
    renderSettings();
    expect(screen.getByTestId("st-section-connect")).toBeInTheDocument();
    expect(screen.queryByTestId("st-section-privacy")).toBeNull();
    expect(screen.queryByTestId("st-section-sync")).toBeNull();
  });

  it("Connect section shows all 4 IDE capture rows", async () => {
    renderSettings();
    await waitFor(() =>
      expect(
        screen.getByTestId("st-personal-agent-row-cursor"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("st-personal-agent-row-claude_code"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-codex"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("st-personal-agent-row-windsurf"),
    ).toBeInTheDocument();
    // 4 cloud-agent rows are GONE — they were in the v1.15 grid.
    expect(screen.queryByTestId("st-personal-agent-row-devin")).toBeNull();
    expect(
      screen.queryByTestId("st-personal-agent-row-replit"),
    ).toBeNull();
    expect(
      screen.queryByTestId("st-personal-agent-row-apple_intelligence"),
    ).toBeNull();
    expect(
      screen.queryByTestId("st-personal-agent-row-ms_copilot"),
    ).toBeNull();
  });

  it("Connect section embeds the external sources directory", () => {
    renderSettings();
    expect(
      screen.getByTestId("st-connect-external-sources"),
    ).toBeInTheDocument();
    // The wrapped SourcesSettings renders its own list testid.
    expect(screen.getByTestId("settings-sources-list")).toBeInTheDocument();
  });

  it("Privacy tab switches to the honest R6 panel", async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("st-tab-privacy"));
    await waitFor(() =>
      expect(screen.getByTestId("st-section-privacy")).toBeInTheDocument(),
    );
    // The R6 panel includes the ASCII data-flow diagram + "100% on your
    // machines" copy (load-bearing claim).
    await waitFor(() =>
      expect(screen.getByTestId("st-privacy-diagram")).toBeInTheDocument(),
    );
    const root = screen.getByTestId("st-section-privacy");
    expect(root.textContent).toMatch(/100% on your machines/i);
  });

  it("Sync tab shows Solo / Team mode picker, github URL, personal vault", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("st-tab-sync"));
    expect(screen.getByTestId("st-sync-mode")).toBeInTheDocument();
    expect(screen.getByTestId("st-sync-mode-solo")).toBeInTheDocument();
    expect(screen.getByTestId("st-sync-mode-team")).toBeInTheDocument();
    // Team mode (default in test) → github URL + personal-vault sections.
    expect(screen.getByTestId("st-sync-github-url")).toBeInTheDocument();
    expect(
      screen.getByTestId("st-sync-personal-vault"),
    ).toBeInTheDocument();
  });

  it("Cursor capture toggle is reachable in ≤2 clicks from /settings", async () => {
    renderSettings();
    // Click 1: Connect tab is already the default — no click needed, but
    // count the implicit landing as click 0. The toggle is click 1.
    const toggle = (await screen.findByTestId(
      "st-personal-agent-toggle-cursor",
    )) as HTMLInputElement;
    expect(toggle).toBeInTheDocument();
    expect(toggle.checked).toBe(false);
  });

  it("Toggling Cursor capture flips the personalAgentsEnabled store key", async () => {
    renderSettings();
    const toggle = (await screen.findByTestId(
      "st-personal-agent-toggle-cursor",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(useStore.getState().ui.personalAgentsEnabled.cursor).toBe(
        true,
      );
    });
  });

  it("Theme selector updates the theme store key", () => {
    renderSettings();
    const select = screen.getByTestId("st-theme") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "dark" } });
    expect(useStore.getState().ui.theme).toBe("dark");
  });

  it("GitHub repo URL update writes through to memoryConfig.repoUrl", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("st-tab-sync"));
    const input = screen.getByTestId("st-github-url") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "git@github.com:foo/bar.git" },
    });
    expect(useStore.getState().ui.memoryConfig.repoUrl).toBe(
      "git@github.com:foo/bar.git",
    );
  });

  it("Personal vault toggle updates memoryConfig.personalDirEnabled", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("st-tab-sync"));
    const toggle = screen.getByTestId(
      "st-sync-personal-toggle",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(
      useStore.getState().ui.memoryConfig.personalDirEnabled,
    ).toBe(false);
  });

  it("Solo mode hides team-only sub-sections", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("st-tab-sync"));
    // Default in test is "init" (Team). Switch to Solo and the github URL
    // + team roster should disappear.
    fireEvent.click(screen.getByTestId("st-sync-mode-solo"));
    expect(screen.queryByTestId("st-sync-github-url")).toBeNull();
    expect(screen.queryByTestId("st-sync-team-roster")).toBeNull();
    // Personal vault still shows in Solo (it's an always-relevant control).
    expect(
      screen.getByTestId("st-sync-personal-vault"),
    ).toBeInTheDocument();
  });

  it("legacy wave-11 Primary-AI-tool picker is NOT rendered anywhere", () => {
    renderSettings();
    expect(screen.queryByTestId("st-ai-primary-channel")).toBeNull();
    expect(screen.queryByTestId("st-ai-redetect")).toBeNull();
  });

  it("legacy AGI / Adapters tabs and panels are NOT rendered", () => {
    renderSettings();
    // No AGI participation card / adapters list anywhere in the shell.
    expect(screen.queryByTestId("st-agi-participation-card")).toBeNull();
    expect(screen.queryByTestId("adapter-row-0")).toBeNull();
    expect(screen.queryByTestId("st-agi-sensitivity")).toBeNull();
  });

  it("legacy ?tab=adapters deep-link redirects to Sync section", async () => {
    renderSettings("/settings?tab=adapters");
    // No adapter UI, just the Sync section.
    await waitFor(() =>
      expect(screen.getByTestId("st-section-sync")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("adapter-row-0")).toBeNull();
  });

  it("legacy ?tab=privacy deep-link still lands on Privacy section", async () => {
    renderSettings("/settings?tab=privacy");
    await waitFor(() =>
      expect(screen.getByTestId("st-section-privacy")).toBeInTheDocument(),
    );
  });
});
