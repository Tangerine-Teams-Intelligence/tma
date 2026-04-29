/**
 * v1.16 Wave 4 D2 — StatusBar tests.
 *
 * Coverage:
 *   1. 4 chips render (Source / Today / Online / @me) when counts > 0.
 *   2. Source chip: 0 active sources → ⚠ amber; ≥1 → 🟢 emerald.
 *   3. Today chip: count derived from `readTimelineRecent` mock.
 *   4. For-you chip: 0 mentions → chip omitted; ≥1 → renders.
 *   5. Click Source → navigate('/settings').
 *   6. Click Today → navigate('/feed?filter=today').
 *   7. Click Online → navigate('/people').
 *   8. Click For-you → navigate('/feed?filter=me').
 *   9. Polling: after STATUS_BAR_POLL_MS, readTimelineRecent re-runs.
 *  10. Onboarding gate: welcomed=false → null; welcomed=true → mounts.
 *
 * `@/lib/views` is spied on per-test so we can drive the readTimelineRecent
 * return value without standing up a Tauri runtime. The presence layer is
 * stubbed via the existing PresenceProvider mock pattern from
 * wave1-13d-presence.test.tsx.
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Tauri presence mocks — the StatusBar reads `useStore` + `usePresence`,
// and PresenceProvider reaches into `@/lib/tauri` on mount. Hoisted so
// the mock is in place before the import graph resolves.
const tauriMocks = vi.hoisted(() => ({
  presenceEmit: vi.fn(async () => {}),
  presenceListActive: vi.fn(async () => [] as Array<unknown>),
  listenPresenceUpdates: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    presenceEmit: tauriMocks.presenceEmit,
    presenceListActive: tauriMocks.presenceListActive,
    listenPresenceUpdates: tauriMocks.listenPresenceUpdates,
  };
});

import { useStore } from "../src/lib/store";
import * as views from "../src/lib/views";
import type { TimelineEvent } from "../src/lib/views";
import {
  StatusBar,
  STATUS_BAR_POLL_MS,
} from "../src/components/layout/StatusBar";
import { PresenceProvider } from "../src/components/presence/PresenceProvider";

// Last route the in-test <RouteSpy/> observed. The stub's render writes
// here so click assertions can confirm navigation without relying on the
// react-router internals.
let lastPath = "";

// Tiny route spy that flushes location.pathname + search to `lastPath`
// on every render. Mounted alongside <StatusBar/> inside MemoryRouter
// so navigation triggered by chip clicks is observable.
function RouteSpy() {
  const { useLocation } = require("react-router-dom");
  const loc = useLocation();
  lastPath = loc.pathname + (loc.search || "");
  return <div data-testid="route-spy" data-path={lastPath} />;
}

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? new Date().toISOString(),
    source: p.source ?? "cursor",
    actor: p.actor ?? "daizhe",
    actors: p.actors ?? [p.actor ?? "daizhe"],
    kind: p.kind ?? "capture",
    refs: p.refs ?? {},
    status: p.status ?? "open",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "Sample body.",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

function renderBar() {
  return render(
    <MemoryRouter initialEntries={["/feed"]}>
      <PresenceProvider heartbeatMs={50_000}>
        <StatusBar />
        <RouteSpy />
      </PresenceProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lastPath = "";
  tauriMocks.presenceEmit.mockClear();
  tauriMocks.presenceListActive.mockReset();
  tauriMocks.listenPresenceUpdates.mockClear();
  tauriMocks.presenceListActive.mockResolvedValue([]);
  tauriMocks.listenPresenceUpdates.mockImplementation(async () => () => {});
  // Default: a welcomed solo user with no sources connected. Each spec
  // overrides the bits it cares about.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      welcomed: true,
      currentUser: "daizhe",
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
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  // Defensive: any spec that flips fake timers must restore real ones
  // so a mid-flight timeout doesn't leak fake clocks into the next spec.
  // Calling useRealTimers when no fake clock was installed is a no-op.
  vi.useRealTimers();
});

describe("Wave 4 D2 — StatusBar", () => {
  it("renders Source/Today/Online chips (For-you hidden at 0)", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() => {
      expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("status-bar-source")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar-today")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar-online")).toBeInTheDocument();
    // 0 mentions → chip is intentionally omitted, not rendered-with-zero.
    expect(screen.queryByTestId("status-bar-forme")).not.toBeInTheDocument();
  });

  it("Source chip is amber/⚠ when 0 sources, emerald/🟢 with ≥1", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-source")).toBeInTheDocument(),
    );
    const chipNoSrc = screen.getByTestId("status-bar-source");
    expect(chipNoSrc.getAttribute("data-active")).toBe("false");
    expect(chipNoSrc.textContent).toContain("No source");
    expect(chipNoSrc.className).toContain("amber");

    // Flip cursor + claude_code on. The chip should re-render emerald.
    act(() => {
      useStore.setState((s) => ({
        ui: {
          ...s.ui,
          personalAgentsEnabled: {
            ...s.ui.personalAgentsEnabled,
            cursor: true,
            claude_code: true,
          },
        },
      }));
    });
    const chipWithSrc = screen.getByTestId("status-bar-source");
    expect(chipWithSrc.getAttribute("data-active")).toBe("true");
    expect(chipWithSrc.textContent).toContain("Cursor");
    expect(chipWithSrc.textContent).toContain("CC");
    expect(chipWithSrc.className).toContain("emerald");
  });

  it("Today chip count derives from readTimelineRecent (last-24h filter)", async () => {
    const evs = [
      makeEvent({ id: "a", ts: new Date().toISOString() }),
      makeEvent({
        id: "b",
        ts: new Date(Date.now() - 60_000).toISOString(),
      }),
      // Older than 24h → must be excluded.
      makeEvent({
        id: "c",
        ts: new Date(Date.now() - 26 * 3600_000).toISOString(),
      }),
    ];
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: evs,
      notes: [],
    });
    renderBar();
    await waitFor(() => {
      expect(screen.getByTestId("status-bar-today").textContent).toContain(
        "2 today",
      );
    });
  });

  it("For-you chip omitted at 0 mentions, rendered when ≥1", async () => {
    // First render with 0 mentions — chip absent.
    vi.spyOn(views, "readTimelineRecent").mockResolvedValueOnce({
      events: [
        makeEvent({ id: "a", body: "Plain capture, no mention." }),
      ],
      notes: [],
    });
    const { unmount } = renderBar();
    await waitFor(() => {
      expect(screen.getByTestId("status-bar-today")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("status-bar-forme")).not.toBeInTheDocument();
    unmount();

    // Re-render with 2 @daizhe mentions — chip should fire.
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [
        makeEvent({ id: "a", body: "Hey @daizhe, please look at this." }),
        makeEvent({ id: "b", body: "Followup for @daizhe re: BOM." }),
      ],
      notes: [],
    });
    renderBar();
    await waitFor(() => {
      expect(screen.getByTestId("status-bar-forme")).toBeInTheDocument();
    });
    expect(screen.getByTestId("status-bar-forme").textContent).toContain(
      "2 @me",
    );
  });

  it("Click Source chip → navigate to /settings", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-source")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("status-bar-source"));
    await waitFor(() => {
      expect(lastPath).toBe("/settings");
    });
  });

  it("Click Today chip → navigate to /feed?filter=today", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-today")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("status-bar-today"));
    await waitFor(() => {
      expect(lastPath).toBe("/feed?filter=today");
    });
  });

  it("Click Online chip → navigate to /people", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-online")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("status-bar-online"));
    await waitFor(() => {
      expect(lastPath).toBe("/people");
    });
  });

  it("Click For-you chip → navigate to /feed?filter=me", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [makeEvent({ id: "a", body: "@daizhe ping" })],
      notes: [],
    });
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-forme")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("status-bar-forme"));
    await waitFor(() => {
      expect(lastPath).toBe("/feed?filter=me");
    });
  });

  it("polls readTimelineRecent every STATUS_BAR_POLL_MS", async () => {
    // Patch window.setInterval so we can inspect what cadence the bar
    // installs without fighting jsdom's real-timers + Promise micro-
    // task ordering. The StatusBar mounts → calls setInterval(tick,
    // STATUS_BAR_POLL_MS) → on unmount calls clearInterval(handle).
    const installed: Array<{ cadenceMs: number; handle: number }> = [];
    const cleared: Array<number> = [];
    let nextHandle = 1;
    const realSetInterval = window.setInterval;
    const realClearInterval = window.clearInterval;
    (window as unknown as { setInterval: typeof setInterval }).setInterval = ((
      _fn: () => void,
      ms?: number,
    ) => {
      const h = nextHandle++;
      installed.push({ cadenceMs: ms ?? 0, handle: h });
      return h as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (window as unknown as {
      clearInterval: typeof clearInterval;
    }).clearInterval = ((h: number) => {
      cleared.push(h);
    }) as typeof clearInterval;
    try {
      const spy = vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
        events: [],
        notes: [],
      });
      const { unmount } = renderBar();
      await waitFor(() => {
        expect(screen.getByTestId("status-bar")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      // Bar installed a single interval at the spec'd cadence.
      const polling = installed.find((i) => i.cadenceMs === STATUS_BAR_POLL_MS);
      expect(polling).toBeTruthy();
      // Unmount → that interval is cleared.
      unmount();
      expect(cleared).toContain(polling!.handle);
    } finally {
      (window as unknown as { setInterval: typeof setInterval }).setInterval =
        realSetInterval;
      (
        window as unknown as { clearInterval: typeof clearInterval }
      ).clearInterval = realClearInterval;
    }
  });

  it("welcomed=false → component renders nothing", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    act(() => {
      useStore.setState((s) => ({
        ui: { ...s.ui, welcomed: false },
      }));
    });
    renderBar();
    // Onboarding-gate: bar is intentionally absent for first-run users.
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });

  it("welcomed=true → component mounts", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderBar();
    await waitFor(() => {
      expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    });
  });

  it("Online chip reads from PresenceProvider (Solo at 0, count at ≥1)", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    // 0 teammates — Solo.
    tauriMocks.presenceListActive.mockResolvedValue([]);
    const { unmount } = renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-online").textContent).toContain(
        "Solo",
      ),
    );
    unmount();

    // ≥1 teammate — count.
    tauriMocks.presenceListActive.mockResolvedValue([
      {
        user: "hongyu",
        current_route: "/memory",
        active_atom: null,
        action_type: "heartbeat",
        last_active: new Date().toISOString(),
        started_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("status-bar-online").textContent).toContain(
        "1 online",
      ),
    );
  });
});
