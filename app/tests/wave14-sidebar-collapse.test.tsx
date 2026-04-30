// === wave 14 ===
// === wave 19 ===
/**
 * Wave 14 sidebar collapse tests — REWRITTEN under Wave 19 IA.
 *
 * Original wave 14 covered the 6→3 sidebar section reduction (Brain /
 * Sources / AI tools defaults, Active Agents + Advanced behind a "Show
 * advanced" toggle). Wave 19 took the simplification further — the
 * sidebar now has ZERO collapsible sections. The 5 primary nav items
 * (Today / Memory / Brain / Canvas + Settings in footer) are always
 * visible; everything else (Sources / AI tools / extra views / graphs)
 * is reachable via Cmd+K and Settings tabs only.
 *
 * The old wave-14 invariants don't survive the rewrite. We keep this
 * file alive (rather than deleting) because a number of upstream test
 * suites import test fixture state via the same `useStore.setState`
 * shape we use here. Tests now assert the wave-19 contract:
 *   1. The Brain section's 4 default links (today / co-thinker / canvas
 *      / memory) all render — even though wave 19 dropped the section
 *      label and renamed /co-thinker to /brain in the sidebar URL, both
 *      paths still resolve to the same React route. /co-thinker is
 *      reachable via Cmd+K, /memory is the wave-19 sidebar URL.
 *   2. There are NO `sidebar-section-*` headers in the DOM (was a
 *      defining wave-14 selector).
 *   3. Killed-from-sidebar routes (this-week, sources, ai-tools)
 *      DO NOT render NavLinks in the rail anymore.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { Sidebar } from "../src/components/layout/Sidebar";
import { useStore } from "../src/lib/store";

describe("Wave 14 sidebar — wave-19 IA contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset to wave-14 defaults so prior test mutations don't leak in.
    // Wave 19's sidebar doesn't read these fields anymore but other
    // suites do — keeping the reset preserves shared-state hygiene.
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

  // === v1.20.0 audit === — all 5 sidebar nav items used to point at
  // routes (/feed, /threads, /people, /canvas, /memory). v1.19's
  // redirect table sends 4 of those to / so clicking did nothing
  // visible. v1.20 rewrote them as buttons that flip ui.canvasView.
  // The only surviving NavLink is /memory (the one route that still
  // works directly). Brand link is now /, not /feed.
  it("v1.20.0 — sidebar exposes 4 canvas-view buttons + 1 Memory NavLink", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // The four T/H/P/R buttons are now <button> elements with stable
    // testids, not <a> links — clicking them flips ui.canvasView.
    expect(screen.getByTestId("sidebar-nav-time")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-heatmap")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-people")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-nav-replay")).toBeInTheDocument();
    // Memory survives as a real NavLink to /memory.
    expect(document.querySelector('a[href="/memory"]')).not.toBeNull();
    // Brand link goes to / (was /feed pre-v1.20).
    expect(document.querySelector('a[href="/"]')).not.toBeNull();
  });

  it("does NOT render sub-sections (no collapsible Sources / AI tools / Active agents)", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // None of the wave-14 section testids exist in wave-19 sidebar.
    expect(screen.queryByTestId("sidebar-section-brain")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-section-sources")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-section-ai-tools")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-section-team-activity"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-section-advanced")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-show-advanced")).not.toBeInTheDocument();
  });

  it("v1.20.0 — none of the dead-redirect routes appear as direct NavLinks", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // v1.20 explicitly killed direct links to /feed, /threads, /people,
    // /canvas — they all redirect to / so a NavLink would just look
    // broken. The user reaches those views via the canvas-view buttons
    // (T/H/P/R) which set ui.canvasView in-place.
    const killedHrefs = [
      "/feed",
      "/threads",
      "/people",
      "/canvas",
      "/this-week",
      "/projects",
      "/alignment",
      "/reviews",
      "/marketplace",
      "/sources/discord",
      "/sinks/browser",
      "/today",
      "/brain",
      "/co-thinker",
    ];
    for (const href of killedHrefs) {
      expect(
        document.querySelector(`a[href="${href}"]`),
        `expected sidebar to NOT link directly to ${href} (Cmd+K / canvas-view button only)`,
      ).toBeNull();
    }
  });
});
// === end wave 19 ===
// === end wave 14 ===
