/**
 * v1.18.0 — Heat-map layer (zoomed-out canvas view).
 *
 * Renders the (day × actor) grid as SVG <rect/> cells, color-coded by
 * atom density. This is the GitHub contribution graph for a team:
 * one glance answers "did anything happen this week and who was it?".
 *
 * Visibility is opacity-driven, not display-toggled. CanvasView
 * computes `opacity` from the current zoom scale and crossfades us
 * out as zoom climbs past the threshold (~scale 1.5). Keeping us in
 * the DOM during the fade matters: the AtomLayer reads our cell
 * geometry to anchor each atom card to its parent cell centroid, so
 * the transition reads as "cells exploding into atoms" instead of
 * "one thing disappears, another appears".
 *
 * No interaction lives here — the parent owns wheel/drag handlers.
 * Click on a cell DOES surface a tooltip-style title via SVG <title>
 * so accessibility tools and hover get a free affordance.
 */

import { useMemo } from "react";
import type { TimelineEvent } from "@/lib/views";
import {
  BAND_COLORS,
  bucketHeatmap,
  dayAxis,
  densityBand,
  peopleAxis,
} from "./bucketing";

export interface HeatmapLayerProps {
  events: TimelineEvent[];
  /** How many days the X-axis spans (default 30). */
  days?: number;
  /** Anchor "now" — pinned in tests. */
  anchorMs?: number;
  /** Cell size in canvas-space px. Both dims equal — square cells. */
  cellSize?: number;
  /** Padding between cells, canvas-space px. */
  gap?: number;
  /** Opacity gate driven by parent zoom level — 1 at zoom-out, 0 at zoom-in. */
  opacity?: number;
}

const CELL_DEFAULT = 18;
const GAP_DEFAULT = 2;

/** Layout result the parent can reuse for AtomLayer cell anchors. */
export interface HeatmapGeometry {
  cellSize: number;
  gap: number;
  days: string[];
  people: string[];
  width: number;
  height: number;
  /** Returns the (x, y) top-left corner of the cell for (day, actor). */
  cellCorner: (day: string, actor: string) => { x: number; y: number } | null;
}

export function computeHeatmapGeometry(
  events: TimelineEvent[],
  opts: { days?: number; anchorMs?: number; cellSize?: number; gap?: number } = {},
): HeatmapGeometry {
  const days = dayAxis(opts.days ?? 30, opts.anchorMs);
  const people = peopleAxis(events);
  const cellSize = opts.cellSize ?? CELL_DEFAULT;
  const gap = opts.gap ?? GAP_DEFAULT;
  const stride = cellSize + gap;
  const dayIdx = new Map(days.map((d, i) => [d, i] as const));
  const peopleIdx = new Map(people.map((p, i) => [p, i] as const));
  return {
    cellSize,
    gap,
    days,
    people,
    width: Math.max(1, days.length * stride),
    height: Math.max(1, people.length * stride),
    cellCorner(day: string, actor: string) {
      const dx = dayIdx.get(day);
      const dy = peopleIdx.get(actor);
      if (dx === undefined || dy === undefined) return null;
      return { x: dx * stride, y: dy * stride };
    },
  };
}

export function HeatmapLayer({
  events,
  days = 30,
  anchorMs,
  cellSize = CELL_DEFAULT,
  gap = GAP_DEFAULT,
  opacity = 1,
}: HeatmapLayerProps) {
  const geom = useMemo(
    () => computeHeatmapGeometry(events, { days, anchorMs, cellSize, gap }),
    [events, days, anchorMs, cellSize, gap],
  );
  const buckets = useMemo(() => bucketHeatmap(events), [events]);

  // Cells iterate axes (not the bucket map) so empty days × empty
  // people render as transparent slots — the grid stays rectangular
  // even if a teammate didn't post for a week.
  return (
    <g
      data-testid="heatmap-layer"
      data-cell-count={geom.days.length * geom.people.length}
      data-max-density={buckets.max}
      style={{ opacity, transition: "opacity 100ms ease-out" }}
      pointerEvents={opacity > 0.05 ? "auto" : "none"}
    >
      {/* Day separators — every 7th day gets a faint vertical guide so
          the "week boundary" reads on glance without clutter. */}
      {geom.days.map((day, i) => {
        if (i % 7 !== 0) return null;
        const x = i * (cellSize + gap) - gap / 2;
        return (
          <line
            key={`weekguide-${day}`}
            x1={x}
            x2={x}
            y1={0}
            y2={geom.height}
            stroke="rgb(231 229 228)"
            strokeWidth={1}
            strokeDasharray="2 4"
            opacity={0.6}
          />
        );
      })}
      {geom.days.flatMap((day) =>
        geom.people.map((actor) => {
          const corner = geom.cellCorner(day, actor);
          if (!corner) return null;
          const cell = buckets.cells.get(`${day}|${actor}`);
          const count = cell?.count ?? 0;
          const band = densityBand(count, buckets.max);
          const fill = BAND_COLORS[band];
          const isEmpty = band === 0;
          return (
            <rect
              key={`${day}|${actor}`}
              data-testid={`heat-cell-${day}-${actor}`}
              data-day={day}
              data-actor={actor}
              data-count={count}
              data-density={band}
              x={corner.x}
              y={corner.y}
              width={cellSize}
              height={cellSize}
              rx={3}
              ry={3}
              fill={fill}
              stroke={isEmpty ? "rgb(245 245 244 / 0.6)" : "transparent"}
              strokeWidth={isEmpty ? 1 : 0}
            >
              <title>
                {`${actor} · ${day} · ${count} atom${count === 1 ? "" : "s"}`}
              </title>
            </rect>
          );
        }),
      )}
    </g>
  );
}

export default HeatmapLayer;
