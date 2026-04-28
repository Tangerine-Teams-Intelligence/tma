// === v1.15.0 Wave 2.2 ===
/**
 * Wave 2.2 empty-state tests.
 *
 * Covers:
 *   - First-time empty (firstAtomCapturedAt = null) → EmptyStateCard renders
 *     with the surface-specific copy + CTA on each of the 6 routes.
 *   - Returning-user empty (firstAtomCapturedAt set) → falls back to the
 *     lighter "no items" message; no onboarding CTA.
 *   - Primary CTA navigates to the contracted target route.
 *   - Secondary "See the demo" CTA flips `demoMode = true` in the store.
 *   - `empty_state_shown` fires on render, `empty_state_cta_clicked` fires
 *     on primary click, both with the correct `surface` payload.
 *
 * Coordination: this suite reads `firstAtomCapturedAt` defensively (the
 * field is W1.4's). When W1.4 ships its store changes the cast in the
 * route files becomes a real type; until then these tests poke the slice
 * via `useStore.setState({ ui: { ...current, firstAtomCapturedAt: ... }})`
 * which works regardless of whether W1.4 has landed.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import PeopleListRoute from "../src/routes/people";
import PersonDetailRoute from "../src/routes/people/detail";
import ThreadsListRoute from "../src/routes/threads";
import ThreadDetailRoute from "../src/routes/threads/detail";
import TodayRoute from "../src/routes/today";
import ThisWeekRoute from "../src/routes/this-week";
import { EmptyStateCard } from "../src/components/EmptyStateCard";
import { MemoryTree } from "../src/components/memory/MemoryTree";

import * as views from "../src/lib/views";
import * as telemetry from "../src/lib/telemetry";
import { useStore } from "../src/lib/store";

// Helper to flip W1.4's flag without depending on whether the field has
// been added to the typed slice yet. We splat the existing ui slice and
// overwrite just `firstAtomCapturedAt`.
function setFirstCaptured(value: string | null) {
  const current = useStore.getState();
  useStore.setState({
    ...current,
    ui: {
      ...current.ui,
      // The field may or may not exist in the typed UiSlice yet — the
      // spread+cast is the safest write path during W1.4's parallel ship.
      ...(({ firstAtomCapturedAt: value } as unknown) as Record<string, unknown>),
    },
  });
}

beforeEach(() => {
  // Reset the W1.4 flag to "fresh user" before every test.
  setFirstCaptured(null);
  // Reset demoMode to false before every test so the secondary CTA
  // assertion has a clean baseline.
  useStore.getState().ui.setDemoMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        {/* Catch-all so any navigate() lands on a placeholder we can
            assert against without 404'ing the test. */}
        <Route path="*" element={<div data-testid="route-landed">{path}</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Wave 2.2 — EmptyStateCard component", () => {
  it("emits empty_state_shown on render with surface payload", () => {
    const spy = vi.spyOn(telemetry, "logEvent").mockResolvedValue();
    render(
      <MemoryRouter>
        <EmptyStateCard
          icon={<span>i</span>}
          title="t"
          description="d"
          ctaLabel="Go →"
          ctaAction="/setup/connect"
          telemetrySurface="people"
        />
      </MemoryRouter>,
    );
    expect(spy).toHaveBeenCalledWith("empty_state_shown", { surface: "people" });
  });

  it("emits empty_state_cta_clicked + invokes string-path navigate on CTA click", () => {
    const spy = vi.spyOn(telemetry, "logEvent").mockResolvedValue();
    render(
      <MemoryRouter initialEntries={["/people"]}>
        <Routes>
          <Route
            path="/people"
            element={
              <EmptyStateCard
                icon={<span>i</span>}
                title="t"
                description="d"
                ctaLabel="Go →"
                ctaAction="/settings/team"
                telemetrySurface="people"
              />
            }
          />
          <Route path="*" element={<div data-testid="route-landed" />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    expect(spy).toHaveBeenCalledWith("empty_state_cta_clicked", {
      surface: "people",
    });
    expect(screen.getByTestId("route-landed")).toBeInTheDocument();
  });

  it("CTA accepts a function action", () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <EmptyStateCard
          icon={<span>i</span>}
          title="t"
          description="d"
          ctaLabel="Go →"
          ctaAction={onClick}
          telemetrySurface="threads"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("'See the demo' secondary CTA flips demoMode = true", () => {
    expect(useStore.getState().ui.demoMode).toBe(false);
    render(
      <MemoryRouter>
        <EmptyStateCard
          icon={<span>i</span>}
          title="t"
          description="d"
          ctaLabel="Go →"
          ctaAction="/setup/connect"
          telemetrySurface="co-thinker"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("empty-state-see-demo"));
    expect(useStore.getState().ui.demoMode).toBe(true);
  });
});

describe("Wave 2.2 — /people empty states", () => {
  it("first-time user sees EmptyStateCard with people copy", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readPeopleList").mockResolvedValue({ people: [], notes: [] });
    renderRoute("/people", <PeopleListRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-card")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Teammates appear here as you capture together/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-card")).toHaveAttribute(
      "data-surface",
      "people",
    );
  });

  it("returning user sees lighter 'No people captured yet' message", async () => {
    setFirstCaptured("2026-04-20T00:00:00Z");
    vi.spyOn(views, "readPeopleList").mockResolvedValue({ people: [], notes: [] });
    renderRoute("/people", <PeopleListRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("people-empty-returning")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });
});

describe("Wave 2.2 — /people/:alias empty states", () => {
  it("first-time user sees EmptyStateCard with person-detail copy", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readPerson").mockResolvedValue({
      alias: "eric",
      recent_events: [],
      mentioned_projects: [],
      mentioned_threads: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/people/eric"]}>
        <Routes>
          <Route path="/people/:alias" element={<PersonDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-card")).toHaveAttribute(
        "data-surface",
        "people-detail",
      );
    });
    expect(screen.getByText(/No interactions with @eric yet/i)).toBeInTheDocument();
  });

  it("returning user sees lighter empty fallback", async () => {
    setFirstCaptured("2026-04-20T00:00:00Z");
    vi.spyOn(views, "readPerson").mockResolvedValue({
      alias: "ghost",
      recent_events: [],
      mentioned_projects: [],
      mentioned_threads: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/people/ghost"]}>
        <Routes>
          <Route path="/people/:alias" element={<PersonDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("person-detail-empty-returning"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });
});

describe("Wave 2.2 — /threads empty states", () => {
  it("first-time user sees EmptyStateCard with threads copy", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readThreadsList").mockResolvedValue({ threads: [], notes: [] });
    renderRoute("/threads", <ThreadsListRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-card")).toHaveAttribute(
        "data-surface",
        "threads",
      );
    });
    expect(
      screen.getByText(/Threads form when AI extracts @mentions/i),
    ).toBeInTheDocument();
  });

  it("returning user sees lighter 'No threads captured yet' message", async () => {
    setFirstCaptured("2026-04-20T00:00:00Z");
    vi.spyOn(views, "readThreadsList").mockResolvedValue({ threads: [], notes: [] });
    renderRoute("/threads", <ThreadsListRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("threads-empty-returning")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });

  it("CTA on /threads navigates to /setup/connect", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readThreadsList").mockResolvedValue({ threads: [], notes: [] });
    render(
      <MemoryRouter initialEntries={["/threads"]}>
        <Routes>
          <Route path="/threads" element={<ThreadsListRoute />} />
          <Route path="*" element={<div data-testid="route-landed" />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-cta")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    await waitFor(() => {
      expect(screen.getByTestId("route-landed")).toBeInTheDocument();
    });
  });
});

describe("Wave 2.2 — /threads/:topic empty states", () => {
  it("first-time user sees EmptyStateCard for empty thread", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readThread").mockResolvedValue({
      topic: "pricing",
      events: [],
      members: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/threads/pricing"]}>
        <Routes>
          <Route path="/threads/:topic" element={<ThreadDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-card")).toHaveAttribute(
        "data-surface",
        "threads-detail",
      );
    });
  });
});

describe("Wave 2.2 — /today empty state", () => {
  it("first-time user sees EmptyStateCard above widget stack when stats=0", async () => {
    setFirstCaptured(null);
    // Force activity bus + tools to be empty so the stat strip resolves
    // to atoms=0 and the onboarding card mounts.
    vi.spyOn(views, "readTimelineToday").mockResolvedValue({
      date: "2026-04-28",
      events: [],
      notes: [],
    });
    renderRoute("/today", <TodayRoute />);
    // The stat strip fetch is a separate effect; wait for the card to
    // appear once the parallel fetch resolves with empties.
    await waitFor(
      () => {
        const card = screen.queryByTestId("empty-state-card");
        if (!card) throw new Error("empty-state-card not yet mounted");
        expect(card).toHaveAttribute("data-surface", "today");
      },
      { timeout: 3000 },
    );
  });

  it("returning user does NOT see EmptyStateCard on /today", async () => {
    setFirstCaptured("2026-04-20T00:00:00Z");
    vi.spyOn(views, "readTimelineToday").mockResolvedValue({
      date: "2026-04-28",
      events: [],
      notes: [],
    });
    renderRoute("/today", <TodayRoute />);
    // Give effects a tick to flush.
    await waitFor(() => {
      expect(screen.getByTestId("today-widget-stack")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });
});

describe("Wave 2.2 — /this-week empty state", () => {
  it("first-time user sees EmptyStateCard when no week events", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderRoute("/this-week", <ThisWeekRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-card")).toHaveAttribute(
        "data-surface",
        "this-week",
      );
    });
  });
});

describe("Wave 2.2 — /memory MemoryTree empty branch", () => {
  it("first-time user sees onboarding card when nodes=[]", () => {
    setFirstCaptured(null);
    render(
      <MemoryRouter>
        <MemoryTree nodes={[]} selectedPath={null} onSelect={() => {}} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("memory-tree-empty-onboarding");
    expect(card).toBeInTheDocument();
    // The test-id override replaces the default `empty-state-card` so we
    // assert on the surface attr via the override id.
    expect(card).toHaveAttribute("data-surface", "memory-tree");
  });

  it("returning user sees lighter '(empty)' line", () => {
    setFirstCaptured("2026-04-20T00:00:00Z");
    render(
      <MemoryRouter>
        <MemoryTree nodes={[]} selectedPath={null} onSelect={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("memory-tree-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("memory-tree-empty-onboarding"),
    ).not.toBeInTheDocument();
  });

  it("active filter never shows onboarding card even for first-time user", () => {
    setFirstCaptured(null);
    render(
      <MemoryRouter>
        <MemoryTree
          nodes={[]}
          selectedPath={null}
          onSelect={() => {}}
          filter="search-term"
        />
      </MemoryRouter>,
    );
    // With a filter active the lighter "no matches" line wins so we
    // don't shout "Capture your first atom →" when the user is just
    // searching for nothing.
    expect(screen.getByTestId("memory-tree-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("memory-tree-empty-onboarding"),
    ).not.toBeInTheDocument();
  });
});

describe("Wave 2.2 — R6/R7/R8 defense", () => {
  it("/people fetch error path does NOT mount EmptyStateCard", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readPeopleList").mockRejectedValue(new Error("boom"));
    renderRoute("/people", <PeopleListRoute />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't read people/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });

  it("/threads fetch error path does NOT mount EmptyStateCard", async () => {
    setFirstCaptured(null);
    vi.spyOn(views, "readThreadsList").mockRejectedValue(new Error("boom"));
    renderRoute("/threads", <ThreadsListRoute />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't read threads/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-card")).not.toBeInTheDocument();
  });
});
// === end v1.15.0 Wave 2.2 ===
