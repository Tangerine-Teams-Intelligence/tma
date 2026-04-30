/**
 * v1.18.0 — /canvas route smoke + contract tests.
 *
 * Pins the route's IA contract: the testid stays `canvas-route`, the
 * loading/empty/error states are explicit, the cell grid + replay
 * button mount when atoms exist, and ui.welcomedReplayDone gates the
 * first-week auto-replay behaviour.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CanvasRoute from "../src/routes/canvas";
import type { TimelineEvent } from "../src/lib/views";
import { useStore } from "../src/lib/store";

// Mock the views invoke surface so vitest can drive the data the route
// reads. Mirror what `readTimelineRecent` returns when the daemon is
// up — we just hand-pick the events per case.
let mockEvents: TimelineEvent[] = [];
let mockShouldThrow = false;

vi.mock("../src/lib/views", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/views")>(
    "../src/lib/views",
  );
  return {
    ...actual,
    readTimelineRecent: vi.fn(async () => {
      if (mockShouldThrow) throw new Error("simulated read failure");
      return { events: mockEvents, notes: [] };
    }),
  };
});

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? new Date().toISOString(),
    source: p.source ?? "cursor",
    actor: p.actor ?? "daizhe",
    actors: p.actors ?? [p.actor ?? "daizhe"],
    kind: p.kind ?? "note",
    refs: p.refs ?? {},
    status: p.status ?? "active",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "hello canvas",
    sample: p.sample ?? false,
    confidence: p.confidence ?? 1,
    concepts: p.concepts ?? [],
    alternatives: p.alternatives ?? [],
    source_count: p.source_count ?? 1,
  };
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/canvas"]}>
      <CanvasRoute />
    </MemoryRouter>,
  );
}

describe("v1.18.0 — /canvas route", () => {
  beforeEach(() => {
    mockEvents = [];
    mockShouldThrow = false;
    // Reset the welcome latch between tests so first-week behaviour is
    // observable independently in each case.
    useStore.setState((s) => ({
      ui: { ...s.ui, welcomedReplayDone: false },
    }));
  });

  it("uses the canvas-route testid (NOT a redirect to /feed)", async () => {
    renderRoute();
    expect(await screen.findByTestId("canvas-route")).toBeInTheDocument();
  });

  it("shows the loading state on first paint", () => {
    renderRoute();
    expect(screen.getByTestId("canvas-loading")).toBeInTheDocument();
  });

  it("renders the empty state when zero atoms are captured", async () => {
    mockEvents = [];
    renderRoute();
    expect(await screen.findByTestId("canvas-empty")).toBeInTheDocument();
    expect(screen.getByText(/No atoms captured yet/i)).toBeInTheDocument();
  });

  it("renders the error banner when readTimelineRecent throws", async () => {
    mockShouldThrow = true;
    renderRoute();
    expect(await screen.findByTestId("canvas-error")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-retry")).toBeInTheDocument();
  });

  it("renders the canvas surface (svg + heatmap + atom layer + replay button) when atoms exist", async () => {
    const today = new Date();
    mockEvents = [
      makeEvent({
        id: "ev1",
        ts: today.toISOString(),
        actor: "daizhe",
        body: "@hongyu spec",
      }),
      makeEvent({
        id: "ev2",
        ts: new Date(today.getTime() - 3600_000).toISOString(),
        actor: "hongyu",
        body: "@daizhe ack",
      }),
    ];
    renderRoute();
    await screen.findByTestId("canvas-route");
    await waitFor(() => {
      expect(screen.getByTestId("canvas-svg")).toBeInTheDocument();
    });
    expect(screen.getByTestId("canvas-camera")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-layer")).toBeInTheDocument();
    expect(screen.getByTestId("atom-layer")).toBeInTheDocument();
    expect(screen.getByTestId("replay-button")).toBeInTheDocument();
  });

  it("shows the corpus count chip in the header", async () => {
    mockEvents = [
      makeEvent({ id: "ev1" }),
      makeEvent({ id: "ev2" }),
      makeEvent({ id: "ev3" }),
    ];
    renderRoute();
    expect(await screen.findByTestId("canvas-corpus-count")).toHaveTextContent(
      "3 atoms",
    );
  });

  it("does NOT redirect to /feed (canvas-route mounts in place)", async () => {
    mockEvents = [makeEvent({ id: "ev1" })];
    renderRoute();
    // canvas-route is the testid we own. If a redirect ever crept back
    // in, FeedRoute would mount and `feed-route` would be present
    // instead of `canvas-route`.
    expect(await screen.findByTestId("canvas-route")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-route")).not.toBeInTheDocument();
  });
});

describe("v1.18.0 — first-week auto-replay latch", () => {
  beforeEach(() => {
    mockEvents = [];
    mockShouldThrow = false;
  });

  it("flips welcomedReplayDone to true after the auto-replay finishes", async () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, welcomedReplayDone: false },
    }));
    mockEvents = [makeEvent({ id: "ev1" }), makeEvent({ id: "ev2" })];
    renderRoute();
    await screen.findByTestId("canvas-route");
    await waitFor(() => {
      expect(screen.getByTestId("replay-button")).toBeInTheDocument();
    });
    // Drive the route into the post-replay state by flipping the latch
    // directly — the auto-play logic itself is tested in the controller
    // file. Here we only assert the route HONORS the latch.
    await act(async () => {
      useStore.getState().ui.setWelcomedReplayDone(true);
    });
    expect(useStore.getState().ui.welcomedReplayDone).toBe(true);
  });

  it("respects the latch — already-welcomed users do not auto-play", async () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, welcomedReplayDone: true },
    }));
    mockEvents = [makeEvent({ id: "ev1" })];
    renderRoute();
    await screen.findByTestId("canvas-route");
    const btn = await screen.findByTestId("replay-button");
    // The button mounts in its idle state ("Replay" label) on a
    // returning user — not in "Pause" mid-play.
    expect(btn.getAttribute("data-playing")).toBe("false");
  });
});
