// === wave 1.13-D ===
/**
 * Wave 1.13-D — team-presence frontend test suite.
 *
 * Covers:
 *   1. PresenceProvider — emit cadence + read cadence + route-change
 *      triggered emit + exclude-self filter on the read.
 *   2. TeammateAvatar — initial render + route-color dot + tooltip.
 *   3. TeammatesPill — hides at 0 teammates, renders count + popover.
 *   4. SidebarPresenceDots — filters teammates per route + handles
 *      /brain → /co-thinker alias.
 *
 * `@/lib/tauri` is mocked so the tests don't touch the real Tauri
 * runtime; we drive the read return values directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const tauriMocks = vi.hoisted(() => {
  return {
    presenceEmit: vi.fn(async () => {}),
    presenceListActive: vi.fn(async () => [] as Array<unknown>),
    listenPresenceUpdates: vi.fn(async () => () => {}),
  };
});

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
import {
  PresenceProvider,
  usePresence,
} from "../src/components/presence/PresenceProvider";
import { TeammateAvatar } from "../src/components/presence/TeammateAvatar";
import { TeammatesPill } from "../src/components/presence/TeammatesPill";
import { SidebarPresenceDots } from "../src/components/presence/SidebarPresenceDots";

const fixture = (
  user: string,
  route: string,
  ago_sec = 5,
  active_atom: string | null = null,
) => ({
  user,
  current_route: route,
  active_atom,
  action_type: "heartbeat",
  last_active: new Date(Date.now() - ago_sec * 1000).toISOString(),
  started_at: new Date(Date.now() - 60_000).toISOString(),
});

beforeEach(() => {
  tauriMocks.presenceEmit.mockClear();
  tauriMocks.presenceListActive.mockReset();
  tauriMocks.listenPresenceUpdates.mockClear();
  tauriMocks.presenceListActive.mockResolvedValue([]);
  tauriMocks.listenPresenceUpdates.mockImplementation(async () => () => {});
  useStore.setState((s) => ({
    ui: { ...s.ui, currentUser: "daizhe" },
  }));
});

afterEach(() => {
  cleanup();
});

// ---- 1. PresenceProvider ----

describe("Wave 1.13-D — PresenceProvider", () => {
  function Probe() {
    const { teammatesActive } = usePresence();
    return (
      <ul data-testid="probe">
        {teammatesActive.map((p) => (
          <li key={p.user} data-testid={`probe-${p.user}`}>
            {p.user}
          </li>
        ))}
      </ul>
    );
  }

  it("emits a heartbeat on mount and reads the teammate list", async () => {
    tauriMocks.presenceListActive.mockResolvedValue([
      fixture("hongyu", "/brain", 5),
    ]);
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(tauriMocks.presenceEmit).toHaveBeenCalled();
    });
    // First emit carries the current route + currentUser.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstCall = (tauriMocks.presenceEmit.mock.calls as any[])[0]?.[0] as {
      user: string;
      currentRoute: string;
    };
    expect(firstCall.user).toBe("daizhe");
    expect(firstCall.currentRoute).toBe("/today");

    // Reader populated the context with the teammate.
    await waitFor(() => {
      expect(screen.getByTestId("probe-hongyu")).toBeInTheDocument();
    });

    // Reader was invoked with our currentUser as the exclude filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastReadCall = (tauriMocks.presenceListActive.mock.calls as any[]).at(
      -1,
    )?.[0] as { excludeUser?: string | null; ttlSeconds?: number };
    expect(lastReadCall?.excludeUser).toBe("daizhe");
    expect(lastReadCall?.ttlSeconds).toBe(60);
  });

  it("emits an additional heartbeat on every route change", async () => {
    tauriMocks.presenceListActive.mockResolvedValue([]);
    const { rerender } = render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(tauriMocks.presenceEmit).toHaveBeenCalled();
    });
    const beforeCount = tauriMocks.presenceEmit.mock.calls.length;

    // Re-render under a different route key — MemoryRouter remounts the
    // tree which fires the route-change effect AND the mount effect; we
    // only care that at least one additional emit fires after the change.
    rerender(
      <MemoryRouter initialEntries={["/memory"]} key="next">
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(tauriMocks.presenceEmit.mock.calls.length).toBeGreaterThan(
        beforeCount,
      );
    });
    // Latest call carries the new route.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastCall = (tauriMocks.presenceEmit.mock.calls as any[]).at(-1)?.[0] as {
      currentRoute: string;
    };
    expect(lastCall.currentRoute).toBe("/memory");
  });
});

// ---- 2. TeammateAvatar ----

describe("Wave 1.13-D — TeammateAvatar", () => {
  it("renders an initial + colored route dot + tooltip", () => {
    const p = fixture("hongyu", "/memory", 12);
    render(<TeammateAvatar presence={p} />);
    const tile = screen.getByTestId("teammate-avatar-hongyu");
    expect(tile).toBeInTheDocument();
    expect(tile.textContent).toContain("H");
    // Route dot present.
    expect(
      screen.getByTestId("teammate-avatar-hongyu-dot"),
    ).toBeInTheDocument();
    // Tooltip carries the route + relative time.
    expect(tile.getAttribute("title")).toContain("/memory");
    expect(tile.getAttribute("title")).toMatch(/s ago|now/);
  });

  it("respects displayName override + hides the route dot when asked", () => {
    const p = fixture("hongyu", "/memory");
    render(
      <TeammateAvatar presence={p} displayName="Hongyu Xu" showRouteDot={false} />,
    );
    const tile = screen.getByTestId("teammate-avatar-hongyu");
    expect(tile.textContent).toContain("H");
    expect(
      screen.queryByTestId("teammate-avatar-hongyu-dot"),
    ).not.toBeInTheDocument();
  });
});

// ---- 3. TeammatesPill ----

describe("Wave 1.13-D — TeammatesPill", () => {
  it("renders nothing when zero teammates active (solo session)", async () => {
    tauriMocks.presenceListActive.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <TeammatesPill />
        </PresenceProvider>
      </MemoryRouter>,
    );
    // Wait one tick for the read to settle.
    await waitFor(() => {
      expect(tauriMocks.presenceListActive).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("presence-pill")).not.toBeInTheDocument();
  });

  it("renders the count + popover with one row per teammate", async () => {
    tauriMocks.presenceListActive.mockResolvedValue([
      fixture("hongyu", "/brain", 5),
      fixture("alice", "/canvas", 8),
    ]);
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <TeammatesPill />
        </PresenceProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("presence-pill")).toBeInTheDocument();
    });
    expect(screen.getByTestId("presence-pill").textContent).toMatch(
      /2 teammates active/i,
    );
    // Click to open popover.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /teammates active/i }));
    });
    expect(
      screen.getByTestId("presence-pill-row-hongyu"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("presence-pill-row-alice"),
    ).toBeInTheDocument();
  });
});

// ---- 4. SidebarPresenceDots ----

describe("Wave 1.13-D — SidebarPresenceDots", () => {
  it("filters teammates by route prefix + matches /brain to /co-thinker", async () => {
    tauriMocks.presenceListActive.mockResolvedValue([
      fixture("hongyu", "/co-thinker", 5),
      fixture("alice", "/canvas", 8),
      fixture("bob", "/brain", 3),
    ]);
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <>
            <SidebarPresenceDots route="/brain" />
            <SidebarPresenceDots route="/canvas" />
            <SidebarPresenceDots route="/today" />
          </>
        </PresenceProvider>
      </MemoryRouter>,
    );

    // Reader has settled — /brain matches Hongyu (/co-thinker) + Bob (/brain).
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-presence-/brain")).toBeInTheDocument();
    });
    const brainGroup = screen.getByTestId("sidebar-presence-/brain");
    expect(
      brainGroup.querySelector('[data-testid="teammate-avatar-hongyu"]'),
    ).toBeInTheDocument();
    expect(
      brainGroup.querySelector('[data-testid="teammate-avatar-bob"]'),
    ).toBeInTheDocument();

    // /canvas matches alice only.
    const canvasGroup = screen.getByTestId("sidebar-presence-/canvas");
    expect(
      canvasGroup.querySelector('[data-testid="teammate-avatar-alice"]'),
    ).toBeInTheDocument();

    // /today matches no one — component should not render at all.
    expect(
      screen.queryByTestId("sidebar-presence-/today"),
    ).not.toBeInTheDocument();
  });
});
// === end wave 1.13-D ===
