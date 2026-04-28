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

  it("renders the 4 primary nav links (today / brain / canvas / memory)", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Wave 19 — /brain is the new sidebar URL, /co-thinker is the
    // legacy alias. Sidebar renders a NavLink to /brain (not
    // /co-thinker). The route in App.tsx wires both paths to the same
    // CoThinkerRoute component.
    const expectedHrefs = ["/today", "/brain", "/canvas", "/memory"];
    for (const href of expectedHrefs) {
      expect(
        document.querySelector(`a[href="${href}"]`),
        `expected sidebar link to ${href}`,
      ).not.toBeNull();
    }
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

  it("killed-from-sidebar routes have no NavLink in the rail", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Routes alive in App.tsx but yanked from the rail in wave 19.
    // === wave 1.13-A === — `/inbox` is no longer in this list. The
    // collab-loop inbox is the 6th rail item now; killed-from-sidebar
    // means "no NavLink AT ALL", which is no longer true for /inbox.
    const killedHrefs = [
      "/this-week",
      "/people",
      "/projects",
      "/threads",
      "/alignment",
      "/reviews",
      "/marketplace",
      "/sources/discord",
      "/sinks/browser",
    ];
    // === end wave 1.13-A ===
    for (const href of killedHrefs) {
      expect(
        document.querySelector(`a[href="${href}"]`),
        `expected sidebar to NOT link directly to ${href} (Cmd+K / Settings only)`,
      ).toBeNull();
    }
  });
});
// === end wave 19 ===
// === end wave 14 ===
