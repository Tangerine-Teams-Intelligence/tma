// === wave 14 ===
/**
 * Wave 14 — Sidebar drastic-collapse tests.
 *
 * Covers Pivot 2: 6 sections → 3 default sections (Brain / Sources /
 * AI tools), with Active Agents + Advanced + extra Views behind a
 * "Show advanced" toggle wired to ui.showAdvancedSettings.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { Sidebar } from "../src/components/layout/Sidebar";
import { useStore } from "../src/lib/store";

describe("Wave 14 — Sidebar 3-section default", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset to wave-14 defaults before every test so prior advanced
    // toggles don't bleed in.
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        showAdvancedSettings: false,
        sidebarSections: {
          brain: true,
          sources: false,
          aiTools: false,
          advanced: false,
          activeAgents: false,
        },
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default rail shows only Brain / Sources / AI tools sections", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Brain section is expanded → its 4 view links render. We assert
    // by anchor href (stable selector) since the visible label text
    // is wrapped in a <span class="truncate"> that confuses ^...$ regex.
    const brainLinks = ["/today", "/co-thinker", "/canvas", "/memory"];
    for (const href of brainLinks) {
      expect(
        document.querySelector(`a[href="${href}"]`),
      ).not.toBeNull();
    }
    // Sources + AI tools sections render their headers.
    expect(screen.getByTestId("sidebar-section-sources")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-section-ai-tools")).toBeInTheDocument();
    // Advanced-tier sections are hidden behind the toggle — their
    // section headers are absent from the DOM.
    expect(
      screen.queryByTestId("sidebar-section-active-agents"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-section-advanced"),
    ).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/this-week"]')).toBeNull();
  });

  it("Show advanced toggle reveals Active agents / Advanced / extra Views", async () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Drive the store directly (matches how Settings.tsx flips this
    // flag — clicking the rail-foot button is just sugar). Wraps in
    // act() so the React batched re-render flushes synchronously
    // before we query the DOM.
    await act(async () => {
      useStore.getState().ui.setShowAdvancedSettings(true);
    });
    expect(useStore.getState().ui.showAdvancedSettings).toBe(true);
    // === wave 12 === — sidebar.activeAgents label renamed "Active agents"
    // → "Team activity" (user-language refactor). The Section component
    // derives data-testid from the visible label via toLowerCase().replace(/\s+/g, "-"),
    // so the testId shifts from `sidebar-section-active-agents` →
    // `sidebar-section-team-activity`.
    expect(
      screen.getByTestId("sidebar-section-team-activity"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-section-advanced"),
    ).toBeInTheDocument();
    expect(document.querySelector('a[href="/this-week"]')).not.toBeNull();
  });

  it("Sources section is collapsed by default (count chip visible)", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Sources items are inside the collapsed section, so e.g. /sources/discord
    // link should NOT render in the DOM yet.
    expect(screen.queryByText(/^Discord$/)).not.toBeInTheDocument();
    // But clicking the section header expands it.
    const sourcesHeader = screen.getByTestId("sidebar-section-sources");
    fireEvent.click(sourcesHeader);
    // Now at least one source item renders.
    expect(useStore.getState().ui.sidebarSections.sources).toBe(true);
  });
});
// === end wave 14 ===
