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

  it("renders the 4 v1.16.1 primary nav links (feed / threads / people / memory)", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // v1.16.1 reshuffled the sidebar to match the new IA: /feed default
    // landing, /threads + /people the other two v1.16 view modes, and
    // /memory as the file-tree power-user fallback. /today /brain
    // /canvas were 砍 in v1.16 Wave 1; the smart-layer routes had no
    // surviving surface to link to.
    const expectedHrefs = ["/feed", "/threads", "/people", "/memory"];
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
    // v1.16.1 killed list. /people + /threads moved INTO the rail
    // (they're the v1.16 view modes), so they're no longer "killed".
    // === v1.18.0 === — /canvas reclaimed as the new heat-map + atom +
    // Replay surface (the founder's "one canvas, two zoom levels"
    // ask). It was on the killed list during v1.16 demolition; now
    // it's a real second-tab nav item, so it's been removed below.
    // /today + /brain stayed killed (smart-layer surfaces still砍).
    const killedHrefs = [
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
        `expected sidebar to NOT link directly to ${href} (Cmd+K / Settings only)`,
      ).toBeNull();
    }
    // === v1.18.0 === — explicit positive assertion that /canvas DOES
    // mount in the rail. Pinned so a future "hide canvas behind a
    // setting" change can't silently kill the founder's spec.
    expect(document.querySelector('a[href="/canvas"]')).not.toBeNull();
    // === end v1.18.0 ===
  });
});
// === end wave 19 ===
// === end wave 14 ===
