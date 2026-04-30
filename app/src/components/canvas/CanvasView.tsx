/**
 * v1.18.0 — CanvasView: the pan/zoom container hosting the heat-map +
 * atom layers. SVG-only (no canvas/WebGL) — keeps accessibility +
 * testability easy and stays at 60fps for the v1.18 corpus floor of
 * ~1k atoms. If we ever blow past 10k we'll swap the inner <svg> for
 * a <canvas> render path; for now SVG ships.
 *
 * Interaction:
 *   - wheel (scroll up) zooms in toward the mouse pointer; (scroll
 *     down) zooms out. Pinch-to-zoom on a trackpad arrives as wheel
 *     events with ctrlKey set, so the same handler covers both.
 *   - drag (mouse-down + move) pans the canvas. Panning never crosses
 *     a zoom threshold so the heat-map ↔ atom crossfade is purely a
 *     wheel concern.
 *
 * Layer crossfade:
 *   - scale ≤ 1.0       → heat-map only
 *   - scale 1.0 – 2.0   → linear crossfade
 *   - scale 2.0 – 3.0   → atoms as dots
 *   - scale ≥ 3.0       → atoms as cards
 *
 * The crossfade math + thresholds are exported so the route can pin
 * them in the changelog and tests can assert them without re-deriving.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEvent } from "@/lib/views";
import { HeatmapLayer, computeHeatmapGeometry } from "./HeatmapLayer";
import { AtomLayer } from "./AtomLayer";
import { computeMentionEdges } from "./bucketing";
import { ReplayButton } from "./ReplayButton";
import { useReplayController } from "./ReplayController";

export const ZOOM_HEATMAP_OPAQUE_BELOW = 1.0;
export const ZOOM_ATOM_FULL_AT = 2.0;
export const ZOOM_ATOM_CARDS_AT = 3.0;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 5.0;

export interface CanvasViewProps {
  events: TimelineEvent[];
  /** Auto-play replay on mount (first-week welcome path). */
  autoPlayReplay?: boolean;
  /** Fired exactly once after auto-play replay completes. */
  onAutoReplayComplete?: () => void;
  /** Days the X-axis spans (default 30). */
  days?: number;
  /** Anchor "now" — pinned in tests. */
  anchorMs?: number;
  /**
   * v1.19.1 Round 2 D — when true, hide CanvasView's internal chrome
   * (Replay button + zoom hint overlay). The v1.19 outer surface owns
   * those affordances now (R is the replay shortcut; the page IS the
   * canvas), so when feed.tsx mounts CanvasView inside HeatmapView /
   * ReplayView it sets this true. Default false for backward compat.
   */
  chromeless?: boolean;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const INITIAL_VIEW: View = { scale: 0.7, tx: 0, ty: 0 };

/** Linear ramp clamped to [0, 1]. Exported for tests. */
export function rampOpacity(scale: number, lo: number, hi: number): number {
  if (scale <= lo) return 0;
  if (scale >= hi) return 1;
  return (scale - lo) / (hi - lo);
}

export function CanvasView({
  events,
  autoPlayReplay = false,
  onAutoReplayComplete,
  days = 30,
  anchorMs,
  chromeless = false,
}: CanvasViewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Track wrapper size so the inner SVG fills the available area.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const rect = e.contentRect;
        setSize({ w: Math.max(1, rect.width), h: Math.max(1, rect.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(
    () => computeHeatmapGeometry(events, { days, anchorMs }),
    [events, days, anchorMs],
  );
  const edges = useMemo(() => computeMentionEdges(events), [events]);

  // Center the content on first paint when we know the wrapper size.
  useEffect(() => {
    setView((prev) => {
      if (prev.tx !== 0 || prev.ty !== 0) return prev;
      return {
        scale: prev.scale,
        tx: (size.w - geom.width * prev.scale) / 2,
        ty: (size.h - geom.height * prev.scale) / 2,
      };
    });
  }, [size.w, size.h, geom.width, geom.height]);

  const replay = useReplayController(events);
  const visibleIds = replay.playing || (replay.progress > 0 && replay.progress < 1)
    ? replay.visibleIds
    : null;

  // Auto-play once on mount when the parent passes the welcome flag.
  // After completion fires `onAutoReplayComplete` so the parent can
  // flip ui.welcomedReplayDone. Re-running of this effect is gated by
  // the autoPlayReplay flag flip so a re-render doesn't restart it.
  const autoPlayedRef = useRef(false);
  useEffect(() => {
    if (!autoPlayReplay) return;
    if (autoPlayedRef.current) return;
    if (events.length === 0) return;
    autoPlayedRef.current = true;
    replay.start();
    // We can't await the replay; instead we let the completion effect
    // below fire onAutoReplayComplete after progress hits 1.
  }, [autoPlayReplay, events.length, replay]);

  const completedFiredRef = useRef(false);
  useEffect(() => {
    if (!autoPlayReplay) return;
    if (replay.progress >= 1 && !completedFiredRef.current) {
      completedFiredRef.current = true;
      onAutoReplayComplete?.();
    }
  }, [autoPlayReplay, replay.progress, onAutoReplayComplete]);

  // ---- Wheel = zoom (mouse-pointer-anchored) ----
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((prev) => {
      // Trackpad pinch arrives with ctrlKey; otherwise treat deltaY as
      // a zoom step too. Negative deltaY = scroll up = zoom in.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clamp(prev.scale * factor, ZOOM_MIN, ZOOM_MAX);
      // Anchor: keep the canvas-space point under the mouse stationary.
      const cx = (px - prev.tx) / prev.scale;
      const cy = (py - prev.ty) / prev.scale;
      const tx = px - cx * next;
      const ty = py - cy * next;
      return { scale: next, tx, ty };
    });
  }

  // ---- Drag = pan ----
  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  }
  function onMouseMove(e: React.MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    setView((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }));
  }
  function onMouseUp() {
    dragRef.current = null;
  }

  // Crossfade opacities derived from current scale.
  const heatOpacity = 1 - rampOpacity(view.scale, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT);
  const atomOpacity = rampOpacity(view.scale, ZOOM_HEATMAP_OPAQUE_BELOW, ZOOM_ATOM_FULL_AT);
  const showCards = view.scale >= ZOOM_ATOM_CARDS_AT;

  return (
    <div
      ref={wrapperRef}
      data-testid="canvas-view"
      data-scale={view.scale.toFixed(3)}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      className="relative h-full w-full overflow-hidden bg-stone-50 dark:bg-stone-950"
      style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
    >
      <svg
        data-testid="canvas-svg"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
      >
        <g
          data-testid="canvas-camera"
          transform={`translate(${view.tx}, ${view.ty}) scale(${view.scale})`}
        >
          <HeatmapLayer
            events={events}
            days={days}
            anchorMs={anchorMs}
            opacity={heatOpacity}
          />
          <AtomLayer
            events={events}
            days={days}
            anchorMs={anchorMs}
            opacity={atomOpacity}
            showCards={showCards}
            edges={edges}
            visibleIds={visibleIds}
          />
        </g>
      </svg>
      {/* Zoom hint overlay so first-time users know the surface is
          zoomable. Self-hides once the user has zoomed in past 1.0.
          v1.19.1 Round 2 D — gated off when `chromeless`. */}
      {!chromeless && view.scale < 1.05 && events.length > 0 && (
        <div
          data-testid="canvas-zoom-hint"
          className="pointer-events-none absolute bottom-3 left-3 rounded border border-stone-200 bg-white/85 px-2 py-1 font-mono text-[10px] text-stone-500 shadow-sm dark:border-stone-700 dark:bg-stone-900/85 dark:text-stone-400"
        >
          scroll to zoom · drag to pan
        </div>
      )}
      {!chromeless && (
        <ReplayButton
          playing={replay.playing}
          progress={replay.progress}
          atomCount={events.length}
          onToggle={replay.toggle}
          onReset={replay.reset}
        />
      )}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export default CanvasView;
