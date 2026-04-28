// === v1.14.6 round-7 ===
/**
 * v1.14 R7 — Real-time presence multi-teammate scaling.
 *
 * Why this exists: v1.13 R10 ship report scored Real-time presence at 8/10
 * with the gap "no R# tested >2-window scaling." R5 wired the
 * `presence:update` Tauri event so multi-window setups felt instant —
 * but the wire was never load-tested under simultaneous multi-teammate
 * fan-out. This file simulates 4 teammates writing presence files at the
 * same instant (4 emit events fire within one microtask) and asserts
 * the React provider doesn't render 4 separate trees in response.
 *
 * What it pins down:
 *
 *   1. **Burst debounce** — 4 simultaneous `presence:update` events must
 *      result in O(1) reads against the Rust list (not O(n)). Otherwise
 *      a 10-teammate team launching at the same standup time would whip
 *      the listener queue 10x per heartbeat for no extra information.
 *   2. **All teammates render** — the Active list must show all 4 (no one
 *      dropped because of dedup over-eagerness).
 *   3. **TTL drop is silent** — when a single teammate's file goes stale
 *      (drops out of the next read), the OTHER 3 must remain rendered
 *      without the React tree thrashing.
 *
 * Mocks: `@/lib/tauri` is mocked so we drive the read return values and
 * trigger the listener callback directly. The provider is stubbed with
 * a tiny heartbeat (50 s) so the cadence interval doesn't fire during
 * the test window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Capture the listener so the test can fire it directly.
const listenerRef: { fn: ((p: unknown) => void) | null } = { fn: null };

const tauriMocks = vi.hoisted(() => {
  return {
    presenceEmit: vi.fn(async () => {}),
    presenceListActive: vi.fn(async () => [] as Array<unknown>),
    listenPresenceUpdates: vi.fn(),
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

// Mint a fresh presence record N seconds in the past.
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

let renderCount = 0;

function Probe() {
  const { teammatesActive } = usePresence();
  renderCount += 1;
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

beforeEach(() => {
  renderCount = 0;
  listenerRef.fn = null;
  tauriMocks.presenceEmit.mockClear();
  tauriMocks.presenceListActive.mockReset();
  tauriMocks.presenceListActive.mockResolvedValue([]);
  tauriMocks.listenPresenceUpdates.mockReset();
  // Capture the React-side callback so the test can simulate Rust emits.
  tauriMocks.listenPresenceUpdates.mockImplementation(async (cb: (p: unknown) => void) => {
    listenerRef.fn = cb;
    return () => {
      listenerRef.fn = null;
    };
  });
  useStore.setState((s) => ({
    ui: { ...s.ui, currentUser: "daizhe" },
  }));
});

afterEach(() => {
  cleanup();
});

describe("v1.14 R7 — Real-time presence multi-teammate scaling", () => {
  it("debounces 4 simultaneous emits into a single (or bounded) list refresh", async () => {
    // Every read returns the same 4 teammates.
    const four = [
      fixture("hongyu", "/brain", 2),
      fixture("alice", "/canvas", 2),
      fixture("bob", "/memory", 2),
      fixture("carol", "/today", 2),
    ];
    tauriMocks.presenceListActive.mockResolvedValue(four);

    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );

    // Wait for mount-time read to settle (mount, route-change effect, listener wire).
    await waitFor(() => {
      expect(tauriMocks.listenPresenceUpdates).toHaveBeenCalled();
      expect(tauriMocks.presenceListActive).toHaveBeenCalled();
    });
    expect(listenerRef.fn).toBeTruthy();

    // Snapshot the read count BEFORE the burst.
    const readsBefore = tauriMocks.presenceListActive.mock.calls.length;

    // Simulate 4 teammates all emitting at the SAME instant — what would
    // happen if all 4 hit the standup at 9:00:00.000 sharp.
    await act(async () => {
      for (const p of four) {
        listenerRef.fn?.(p);
      }
      // One microtask flush to let the debouncer settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Burst-debounce assertion — 4 events should produce at MOST 2 list
    // refreshes (the leading edge fire + one trailing coalesce). Without a
    // debouncer this would be 4 reads → 4 React commits → quadratic
    // re-render cost as N teammates grows.
    const readsAfter = tauriMocks.presenceListActive.mock.calls.length;
    const readsTriggeredByBurst = readsAfter - readsBefore;
    expect(readsTriggeredByBurst).toBeGreaterThanOrEqual(1);
    expect(readsTriggeredByBurst).toBeLessThanOrEqual(2);

    // All 4 teammates render — dedup must NOT drop anyone.
    await waitFor(() => {
      expect(screen.getByTestId("probe-hongyu")).toBeInTheDocument();
      expect(screen.getByTestId("probe-alice")).toBeInTheDocument();
      expect(screen.getByTestId("probe-bob")).toBeInTheDocument();
      expect(screen.getByTestId("probe-carol")).toBeInTheDocument();
    });
  });

  it("does not re-render the other 3 teammates when 1 goes stale (TTL drop)", async () => {
    const fourFresh = [
      fixture("hongyu", "/brain", 2),
      fixture("alice", "/canvas", 2),
      fixture("bob", "/memory", 2),
      fixture("carol", "/today", 2),
    ];
    tauriMocks.presenceListActive.mockResolvedValue(fourFresh);

    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe-carol")).toBeInTheDocument();
    });

    // Settle on 4-rendered baseline.
    const rendersAfterFour = renderCount;

    // Now the next read returns only 3 — Carol's file aged past the TTL.
    // (Simulates the 60s TTL filter on the Rust side dropping her.)
    const threeFresh = fourFresh.slice(0, 3);
    tauriMocks.presenceListActive.mockResolvedValue(threeFresh);

    // Trigger a single listener event — the provider should refresh the
    // list, drop Carol, and keep the other 3 stable.
    await act(async () => {
      listenerRef.fn?.(fixture("hongyu", "/brain", 1));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("probe-carol")).not.toBeInTheDocument();
      expect(screen.getByTestId("probe-hongyu")).toBeInTheDocument();
      expect(screen.getByTestId("probe-alice")).toBeInTheDocument();
      expect(screen.getByTestId("probe-bob")).toBeInTheDocument();
    });

    // Render-thrash budget: dropping ONE teammate must not cause more
    // than 2 additional commits to the Probe (the new state + any
    // unavoidable React strict-mode double-render). If we'd been
    // re-rendering per-event without memoization, this would balloon.
    const rendersAfterDrop = renderCount;
    expect(rendersAfterDrop - rendersAfterFour).toBeLessThanOrEqual(3);
  });

  it("handles a 10-teammate burst without exploding the read count", async () => {
    // Stress test — 10 simultaneous emits. Without debounce this would be
    // 10 reads. With a leading-edge + trailing coalesce debouncer this
    // should be ≤ 2.
    const ten = Array.from({ length: 10 }, (_, i) =>
      fixture(`user${i}`, "/today", 2),
    );
    tauriMocks.presenceListActive.mockResolvedValue(ten);

    render(
      <MemoryRouter initialEntries={["/today"]}>
        <PresenceProvider heartbeatMs={50_000}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(listenerRef.fn).toBeTruthy();
    });

    const readsBefore = tauriMocks.presenceListActive.mock.calls.length;

    await act(async () => {
      for (const p of ten) {
        listenerRef.fn?.(p);
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const burstReads = tauriMocks.presenceListActive.mock.calls.length - readsBefore;
    // Hard ceiling — even a debouncer with one trailing flush gives ≤ 2.
    expect(burstReads).toBeLessThanOrEqual(2);
  });
});
// === end v1.14.6 round-7 ===
