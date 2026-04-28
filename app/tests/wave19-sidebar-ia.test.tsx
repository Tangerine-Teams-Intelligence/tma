// === wave 19 ===
/**
 * Wave 19 — Information Architecture redesign tests.
 *
 * Covers the wave 19 deliverables:
 *   1. Sidebar shows the brand mark (T tile + "Tangerine" wordmark + the
 *      "Your team's AI memory" subtitle) and a 5-item primary nav
 *      (Today / Memory / Brain / Canvas + Settings in the footer).
 *   2. The brand mark's NavLink points to /today.
 *   3. The 4 primary nav items + footer Settings link are clickable.
 *   4. The footer keeps Theme + Sign-out controls.
 *   5. Settings page exposes a "Sources" tab in the default tab band
 *      (no "Show advanced" click required) and renders all 11 sources.
 *   6. Cmd+K palette indexes /brain (the new wave-19 alias) and the
 *      legacy /co-thinker entry, plus every killed-from-sidebar route
 *      (this-week / inbox / alignment / reviews / marketplace / people /
 *      projects / threads / sinks / ai-tools).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { Sidebar } from "../src/components/layout/Sidebar";
import Settings from "../src/pages/settings/Settings";
import { CommandPalette } from "../src/components/CommandPalette";
import { useStore } from "../src/lib/store";
import { SOURCES } from "../src/lib/sources";

beforeEach(() => {
  vi.restoreAllMocks();
  // Reset wave-14/19 store flags so per-suite leakage doesn't bleed in.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      showAdvancedSettings: false,
      paletteOpen: false,
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 19 — Sidebar 5-item IA", () => {
  it("renders the brand mark with logo, wordmark, and subtitle", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Brand mark NavLink → /today.
    const brand = screen.getByTestId("sidebar-brand");
    expect(brand).toBeInTheDocument();
    expect(brand.getAttribute("href")).toBe("/today");
    // Logo tile (orange T) is present.
    expect(screen.getByTestId("tangerine-logo")).toBeInTheDocument();
    // Wordmark.
    expect(screen.getByText("Tangerine")).toBeInTheDocument();
    // Subtitle (positions Tangerine as team-memory app).
    const subtitle = screen.getByTestId("sidebar-brand-subtitle");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle.textContent).toMatch(/team's AI memory/i);
  });

  it("renders exactly 4 primary nav items in the rail body", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Targeted testids ensure we count nav items, not footer links.
    expect(screen.getByTestId("sidebar-nav-today")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-memory")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-brain")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-canvas")).toBeInTheDocument();
    // /brain is the wave-19 sidebar URL; /co-thinker stays alive only as
    // a legacy alias reachable via App.tsx routing (and Cmd+K).
    expect(
      screen.getByTestId("sidebar-nav-brain").getAttribute("href"),
    ).toBe("/brain");
    // Sanity — no /this-week / /reviews / /inbox NavLinks in the rail.
    expect(document.querySelector('a[href="/this-week"]')).toBeNull();
    expect(document.querySelector('a[href="/reviews"]')).toBeNull();
    expect(document.querySelector('a[href="/inbox"]')).toBeNull();
  });

  it("memory nav link is clickable and points at /memory", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const memoryLink = screen.getByTestId("sidebar-nav-memory");
    expect(memoryLink.getAttribute("href")).toBe("/memory");
  });

  it("footer surfaces Settings, Theme cycle, and Sign out", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("sidebar-footer-settings")).toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-footer-settings").getAttribute("href"),
    ).toBe("/settings");
    expect(screen.getByTestId("sidebar-footer-theme")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-footer-signout")).toBeInTheDocument();
  });

  it("does NOT render the wave-14 'Show advanced' rail toggle", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(
      screen.queryByTestId("sidebar-show-advanced"),
    ).not.toBeInTheDocument();
  });
});

describe("Wave 19 — Settings → Sources tab", () => {
  it("Sources tab renders by default (no 'Show advanced' click required)", () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
    // Tab button visible without flipping showAdvancedSettings.
    const sourcesTab = screen.getByTestId("st-tab-sources");
    expect(sourcesTab).toBeInTheDocument();
  });

  it("clicking Sources tab lists all 11 sources by id", () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("st-tab-sources"));
    // The directory list mounts.
    expect(screen.getByTestId("settings-sources-list")).toBeInTheDocument();
    // Every catalog source has a row.
    for (const s of SOURCES) {
      expect(
        screen.getByTestId(`settings-sources-row-${s.id}`),
      ).toBeInTheDocument();
    }
  });
});

describe("Wave 19 — Cmd+K palette indexes brain + killed-from-sidebar routes", () => {
  it("/brain alias and legacy /co-thinker both indexed", () => {
    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    // Static catalog includes /brain (new) and /co-thinker (legacy).
    expect(
      screen.getByTestId("command-palette-item-route:/brain"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("command-palette-item-route:/co-thinker"),
    ).toBeInTheDocument();
  });

  it("every killed-from-sidebar route is reachable via the palette", () => {
    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    const killedRoutes = [
      "/reviews",
      "/marketplace",
      "/inbox",
      "/alignment",
      "/this-week",
      "/people",
      "/projects",
      "/threads",
      "/decisions/lineage",
      "/people/social",
      "/projects/topology",
      "/sources/discord",
      "/sources/slack",
      "/sources/github",
      "/sources/linear",
      "/sources/cal",
      "/sources/notion",
      "/sources/loom",
      "/sources/zoom",
      "/sources/email",
      "/sources/voice-notes",
      "/sources/external",
      "/sinks/browser",
      "/sinks/mcp",
      "/sinks/local-ws",
    ];
    for (const path of killedRoutes) {
      expect(
        screen.getByTestId(`command-palette-item-route:${path}`),
        `expected palette to index ${path}`,
      ).toBeInTheDocument();
    }
  });

  it("'pages' section header replaces wave-14 'navigate' label", async () => {
    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    // Section header for `route` items uses the wave-19 "pages" label.
    await waitFor(() => {
      const header = screen.queryAllByTestId("command-palette-section-route");
      expect(header.length).toBeGreaterThan(0);
      expect(header[0].textContent?.toLowerCase()).toContain("pages");
    });
  });

  it("primary sidebar items are also reachable via the palette", () => {
    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    const sidebarItems = ["/today", "/memory", "/brain", "/canvas", "/settings"];
    for (const path of sidebarItems) {
      expect(
        screen.getByTestId(`command-palette-item-route:${path}`),
        `expected palette to also index sidebar item ${path}`,
      ).toBeInTheDocument();
    }
  });
});
// === end wave 19 ===
