// === wave 16 ===
/**
 * Wave 16 — right-rail ActivityFeed wiring.
 *
 * Covers the wave 16 deliverable: the right-rail ACTIVITY panel reads
 * its initial state via `activityRecent` and subscribes to live
 * `activity:atom_written` events via `listenActivityAtoms`. Three
 * filter tabs (`all` / `me` / `team`) persist their selection in
 * `ui.activityFeedFilter`.
 *
 * We mock `@/lib/tauri` so the tests don't try to import the real
 * Tauri runtime and so we can control the `listen` callback to fire
 * synthetic events on demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Hoisted mocks — must run before SUT module load.
const tauriMocks = vi.hoisted(() => {
  type Cb = (e: {
    path: string;
    title: string;
    vendor: string | null;
    author: string | null;
    timestamp: string;
    kind: "decision" | "thread" | "brain_update" | "timeline" | "observation";
  }) => void;
  let savedCallback: Cb | null = null;
  return {
    activityRecent: vi.fn(),
    listenActivityAtoms: vi.fn(async (cb: Cb) => {
      savedCallback = cb;
      return () => {
        savedCallback = null;
      };
    }),
    fireEvent: (e: Parameters<Cb>[0]) => {
      if (savedCallback) savedCallback(e);
    },
    reset: () => {
      savedCallback = null;
    },
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    activityRecent: tauriMocks.activityRecent,
    listenActivityAtoms: tauriMocks.listenActivityAtoms,
  };
});

import { useStore } from "../src/lib/store";
import { ActivityFeed } from "../src/components/ActivityFeed";

beforeEach(() => {
  tauriMocks.activityRecent.mockReset();
  tauriMocks.listenActivityAtoms.mockClear();
  tauriMocks.reset();
  // Reset the persisted store state between tests so the filter
  // selection from one test doesn't leak into the next.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      activityFeedFilter: "all",
      currentUser: "me",
      dismissedAtoms: [],
    },
  }));
});

afterEach(() => {
  cleanup();
});

function renderFeed(): void {
  render(
    <MemoryRouter>
      <ActivityFeed />
    </MemoryRouter>,
  );
}

describe("Wave 16 — ActivityFeed wiring", () => {
  it("renders the empty state when the ring buffer has no events", async () => {
    tauriMocks.activityRecent.mockResolvedValue([]);
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("activity-empty")).toBeInTheDocument();
    });
    expect(screen.getByText(/Nothing captured yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Connect a source to start the feed\./i),
    ).toBeInTheDocument();
  });

  it("renders rows hydrated from activityRecent on mount", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "team/co-thinker.md",
        title: "Brain refresh",
        vendor: null,
        author: null,
        timestamp: new Date().toISOString(),
        kind: "brain_update",
      },
      {
        path: "personal/me/threads/cursor/abc.md",
        title: "Patent review",
        vendor: "cursor",
        author: "me",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
    ]);
    renderFeed();
    await waitFor(() => {
      const rows = screen.getAllByTestId("activity-row");
      expect(rows.length).toBe(2);
    });
    expect(screen.getByText(/Brain refresh/)).toBeInTheDocument();
    expect(screen.getByText(/Patent review/)).toBeInTheDocument();
  });

  it("filters rows by 'me' / 'team' based on author and persists the choice", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "personal/me/threads/cursor/me1.md",
        title: "My thread",
        vendor: "cursor",
        author: "me",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
      {
        path: "personal/al/threads/claude-code/al1.md",
        title: "Al's thread",
        vendor: "claude-code",
        author: "al",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
      {
        path: "personal/bo/threads/cursor/bo1.md",
        title: "Bo's thread",
        vendor: "cursor",
        author: "bo",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
    ]);

    renderFeed();
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row").length).toBe(3);
    });

    // Switch to "me" — only the row authored by "me" should remain.
    fireEvent.click(screen.getByTestId("activity-filter-me"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("activity-row");
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toMatch(/My thread/);
    });

    // Switch to "team" — the two non-me rows should remain.
    fireEvent.click(screen.getByTestId("activity-filter-team"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("activity-row");
      expect(rows.length).toBe(2);
      expect(rows.some((r) => r.textContent?.includes("Al's thread"))).toBe(
        true,
      );
      expect(rows.some((r) => r.textContent?.includes("Bo's thread"))).toBe(
        true,
      );
    });

    // The store mirror persists the selection.
    expect(useStore.getState().ui.activityFeedFilter).toBe("team");

    // Switch back to "all" — every row should reappear.
    fireEvent.click(screen.getByTestId("activity-filter-all"));
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row").length).toBe(3);
    });
  });

  it("prepends new events from listenActivityAtoms to the top of the rail", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "team/co-thinker.md",
        title: "Old brain refresh",
        vendor: null,
        author: null,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        kind: "brain_update",
      },
    ]);
    renderFeed();
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row").length).toBe(1);
    });
    // Wait for the listen subscription to resolve so savedCallback is in scope.
    await waitFor(() => {
      expect(tauriMocks.listenActivityAtoms).toHaveBeenCalled();
    });

    // Fire a synthetic "atom written" event — it must prepend.
    act(() => {
      tauriMocks.fireEvent({
        path: "personal/me/threads/cursor/new.md",
        title: "Brand new thread",
        vendor: "cursor",
        author: "me",
        timestamp: new Date().toISOString(),
        kind: "thread",
      });
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId("activity-row");
      expect(rows.length).toBe(2);
      // Newest first — the brand-new event should be on top.
      expect(rows[0].textContent).toMatch(/Brand new thread/);
      expect(rows[1].textContent).toMatch(/Old brain refresh/);
    });
  });
});
// === end wave 16 ===
