/**
 * v1.18.0 — Replay timelapse engine.
 *
 * The "Apple Photos Memories video" of the Tangerine canvas: a 5s
 * playthrough where atoms light up in `ts` order and mention edges
 * draw themselves as both endpoints become visible. Auto-plays once
 * per install on first visit (gated by ui.welcomedReplayDone), then
 * only when the user explicitly presses Replay.
 *
 * Design choices:
 *   - State lives in a parent-managed hook (useReplayState) so the
 *     CanvasView can pass `visibleIds` straight to AtomLayer without
 *     prop-drilling pause/skip handlers through every layer.
 *   - 5s total duration regardless of corpus size — visually the eye
 *     can absorb maybe 200 distinct light-ups in 5s, so we sample
 *     atoms uniformly across the timeline at higher counts.
 *   - 60fps via requestAnimationFrame; pauses cleanly via cancelAnimationFrame.
 *   - Outside browsers (vitest jsdom), rAF still exists but timing
 *     is jittery. The hook exposes `step(now)` so tests can drive the
 *     timeline deterministically without timer mocks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "@/lib/views";

export interface ReplayState {
  playing: boolean;
  /** Floating-point progress through the timelapse, 0..1. */
  progress: number;
  /** Set of event ids visible at this point. */
  visibleIds: ReadonlySet<string>;
}

export const REPLAY_DURATION_MS = 5000;

export function useReplayController(events: TimelineEvent[]): ReplayState & {
  /** Optional explicit clock for deterministic test driving. */
  start: (nowMs?: number) => void;
  pause: () => void;
  resume: (nowMs?: number) => void;
  reset: () => void;
  toggle: (nowMs?: number) => void;
  /** Drive one frame; exported so tests can step deterministically. */
  step: (nowMs: number) => void;
} {
  // Sort newest-last so the timeline goes oldest → newest as progress 0 → 1.
  const ordered = useRef<TimelineEvent[]>([]);
  ordered.current = [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const baseProgressRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const visibleSetRef = useRef<Set<string>>(new Set());
  const [, force] = useState(0);

  const recomputeVisible = useCallback((p: number) => {
    const list = ordered.current;
    if (list.length === 0) {
      visibleSetRef.current = new Set();
      return;
    }
    // Count of atoms revealed at progress p — one extra so progress=0
    // still surfaces the very first atom and the user sees something
    // pop in at t=0 instead of staring at an empty canvas for 25ms.
    const cap = Math.min(list.length, Math.ceil(p * list.length));
    const next = new Set<string>();
    for (let i = 0; i < cap; i += 1) {
      next.add(list[i].id);
    }
    if (cap === 0 && list.length > 0) next.add(list[0].id);
    visibleSetRef.current = next;
  }, []);

  const step = useCallback(
    (nowMs: number) => {
      if (startedAtRef.current === null) return;
      const elapsed = nowMs - startedAtRef.current;
      const p = Math.min(
        1,
        baseProgressRef.current + elapsed / REPLAY_DURATION_MS,
      );
      setProgress(p);
      recomputeVisible(p);
      if (p >= 1) {
        setPlaying(false);
        rafRef.current = null;
        startedAtRef.current = null;
      }
      force((n) => n + 1);
    },
    [recomputeVisible],
  );

  // RAF loop. We re-attach when `playing` flips so a paused state
  // doesn't keep ticking. Cleaning up cancels the pending frame.
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const loop = (t: number) => {
      if (cancelled) return;
      step(t);
      // After step, `playing` may have flipped to false. We read the
      // ref-shadow via setPlaying's effect re-run; safe-guard via
      // the rafRef.
      if (rafRef.current !== null) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playing, step]);

  const start = useCallback(
    (nowMs?: number) => {
      baseProgressRef.current = 0;
      setProgress(0);
      recomputeVisible(0);
      startedAtRef.current = nowMs ?? performanceNowSafe();
      setPlaying(true);
    },
    [recomputeVisible],
  );

  const pause = useCallback(() => {
    if (!playing) return;
    // Snapshot current progress so resume picks up where we left off.
    baseProgressRef.current = progress;
    startedAtRef.current = null;
    setPlaying(false);
  }, [playing, progress]);

  const resume = useCallback(
    (nowMs?: number) => {
      if (playing || progress >= 1) return;
      startedAtRef.current = nowMs ?? performanceNowSafe();
      setPlaying(true);
    },
    [playing, progress],
  );

  const reset = useCallback(() => {
    baseProgressRef.current = 0;
    setProgress(0);
    visibleSetRef.current = new Set();
    startedAtRef.current = null;
    setPlaying(false);
    force((n) => n + 1);
  }, []);

  const toggle = useCallback(
    (nowMs?: number) => {
      if (playing) {
        pause();
        return;
      }
      if (progress > 0 && progress < 1) {
        resume(nowMs);
        return;
      }
      start(nowMs);
    },
    [playing, progress, pause, resume, start],
  );

  return {
    playing,
    progress,
    visibleIds: visibleSetRef.current,
    start,
    pause,
    resume,
    reset,
    toggle,
    step,
  };
}

function performanceNowSafe(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export default useReplayController;
