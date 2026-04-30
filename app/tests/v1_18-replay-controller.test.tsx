/**
 * v1.18.0 — Replay controller + button + crossfade math tests.
 *
 * Pins the contract: events reveal in `ts` order, total duration
 * matches REPLAY_DURATION_MS, pause/resume preserve progress, and the
 * crossfade ramp helpers behave linearly inside the threshold band.
 */

import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useReplayController,
  REPLAY_DURATION_MS,
} from "../src/components/canvas/ReplayController";
import {
  rampOpacity,
  ZOOM_HEATMAP_OPAQUE_BELOW,
  ZOOM_ATOM_FULL_AT,
} from "../src/components/canvas/CanvasView";
import type { TimelineEvent } from "../src/lib/views";

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? "2026-04-29T10:00:00Z",
    source: p.source ?? "cursor",
    actor: p.actor ?? "daizhe",
    actors: p.actors ?? [p.actor ?? "daizhe"],
    kind: p.kind ?? "note",
    refs: p.refs ?? {},
    status: p.status ?? "active",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "",
    sample: p.sample ?? false,
    confidence: p.confidence ?? 1,
    concepts: p.concepts ?? [],
    alternatives: p.alternatives ?? [],
    source_count: p.source_count ?? 1,
  };
}

describe("v1.18.0 — useReplayController", () => {
  it("starts with progress 0 and no visible ids", () => {
    const events = [
      makeEvent({ id: "a", ts: "2026-04-25T10:00:00Z" }),
      makeEvent({ id: "b", ts: "2026-04-26T10:00:00Z" }),
      makeEvent({ id: "c", ts: "2026-04-27T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useReplayController(events));
    expect(result.current.progress).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.visibleIds.size).toBe(0);
  });

  it("step() reveals events in ts order over REPLAY_DURATION_MS", () => {
    const events = [
      makeEvent({ id: "c", ts: "2026-04-27T10:00:00Z" }),
      makeEvent({ id: "a", ts: "2026-04-25T10:00:00Z" }),
      makeEvent({ id: "b", ts: "2026-04-26T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useReplayController(events));
    act(() => {
      result.current.start(0);
    });
    // 33% through → roughly first event visible (oldest = "a" since
    // events sort by ts asc inside the controller).
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 0.34);
    });
    expect(result.current.visibleIds.has("a")).toBe(true);
    // 67% through → first two events visible (a, b).
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 0.67);
    });
    expect(result.current.visibleIds.has("a")).toBe(true);
    expect(result.current.visibleIds.has("b")).toBe(true);
    // 100%+ → all three visible, progress saturates at 1, playing flips false.
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 1.1);
    });
    expect(result.current.visibleIds.size).toBe(3);
    expect(result.current.progress).toBe(1);
    expect(result.current.playing).toBe(false);
  });

  it("total duration ≈ REPLAY_DURATION_MS — saturates at exactly 1", () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const { result } = renderHook(() => useReplayController(events));
    act(() => {
      result.current.start(0);
    });
    act(() => {
      result.current.step(REPLAY_DURATION_MS);
    });
    expect(result.current.progress).toBe(1);
  });

  it("pause + resume preserves progress (no jump back to 0)", () => {
    const events = [
      makeEvent({ id: "a", ts: "2026-04-25T10:00:00Z" }),
      makeEvent({ id: "b", ts: "2026-04-26T10:00:00Z" }),
      makeEvent({ id: "c", ts: "2026-04-27T10:00:00Z" }),
      makeEvent({ id: "d", ts: "2026-04-28T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useReplayController(events));
    act(() => {
      result.current.start(0);
    });
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 0.4);
    });
    const beforePause = result.current.progress;
    expect(beforePause).toBeGreaterThan(0.3);
    expect(beforePause).toBeLessThan(0.5);
    act(() => {
      result.current.pause();
    });
    expect(result.current.playing).toBe(false);
    expect(result.current.progress).toBeCloseTo(beforePause, 5);
    act(() => {
      result.current.resume(REPLAY_DURATION_MS * 0.4);
    });
    expect(result.current.playing).toBe(true);
    // Progress is preserved across pause/resume.
    expect(result.current.progress).toBeCloseTo(beforePause, 5);
  });

  it("reset() clears progress + visibility + flips out of play", () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const { result } = renderHook(() => useReplayController(events));
    act(() => {
      result.current.start(0);
    });
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 0.5);
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.progress).toBe(0);
    expect(result.current.visibleIds.size).toBe(0);
    expect(result.current.playing).toBe(false);
  });

  it("toggle() flips between start / pause / resume in the documented sequence", () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    const { result } = renderHook(() => useReplayController(events));
    act(() => {
      result.current.toggle(0);
    });
    expect(result.current.playing).toBe(true);
    act(() => {
      result.current.step(REPLAY_DURATION_MS * 0.3);
    });
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(false);
    act(() => {
      result.current.toggle(REPLAY_DURATION_MS * 0.3);
    });
    expect(result.current.playing).toBe(true);
  });

  it("handles an empty corpus without throwing", () => {
    const { result } = renderHook(() => useReplayController([]));
    act(() => {
      result.current.start(0);
    });
    act(() => {
      result.current.step(REPLAY_DURATION_MS);
    });
    expect(result.current.visibleIds.size).toBe(0);
  });
});

describe("v1.18.0 — crossfade ramp", () => {
  it("rampOpacity stays at 0 below the lower threshold", () => {
    expect(
      rampOpacity(0.5, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT),
    ).toBe(0);
    expect(
      rampOpacity(ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT),
    ).toBe(0);
  });

  it("rampOpacity climbs linearly between thresholds", () => {
    const mid =
      (ZOOM_HEATMAP_OPAQUE_BELOW + ZOOM_ATOM_FULL_AT) / 2;
    const v = rampOpacity(mid, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT);
    expect(v).toBeCloseTo(0.5, 4);
  });

  it("rampOpacity caps at 1 above the upper threshold", () => {
    expect(
      rampOpacity(ZOOM_ATOM_FULL_AT, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT),
    ).toBe(1);
    expect(
      rampOpacity(99, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT),
    ).toBe(1);
  });
});
