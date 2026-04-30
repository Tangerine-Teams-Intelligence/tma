/**
 * v1.18.0 — Atom layer (zoomed-in canvas view).
 *
 * When the user zooms past ~scale 1.5, the heat-map fades out and the
 * atom layer fades in. Each atom is a floating SVG dot anchored at
 * its parent (day, actor) cell centroid plus a small deterministic
 * jitter so multiple atoms in the same cell separate. Atoms in the
 * same thread (= same @mention set) cluster around a shared centroid
 * within the cell so threads visibly group together.
 *
 * @mention edges are pre-computed by the parent and passed in. We
 * render them as 1px translucent orange polylines. The replay
 * controller reveals atoms one-by-one over its 5s timeline; while
 * replaying, only atoms whose `ts` is ≤ replayCursor are visible,
 * and edges only render once both endpoints are visible.
 *
 * The card preview (vendor dot + first body line) only paints once
 * the parent's `cardOpacity` is high enough to read, otherwise we
 * stay as dots — keeps the surface clean during the crossfade.
 */

import { useMemo } from "react";
import type { TimelineEvent } from "@/lib/views";
import { vendorFor } from "@/components/feed/vendor";
import { computeHeatmapGeometry } from "./HeatmapLayer";
import {
  computeMentionEdges,
  threadKeyOf,
  type MentionEdge,
} from "./bucketing";

export interface AtomLayerProps {
  events: TimelineEvent[];
  days?: number;
  anchorMs?: number;
  cellSize?: number;
  gap?: number;
  /** Crossfade opacity from CanvasView (0 zoom-out → 1 zoom-in). */
  opacity?: number;
  /** When true, full atom cards render; when false, just dots. */
  showCards?: boolean;
  /** Pre-computed edge list — pass `null` to skip rendering edges. */
  edges?: MentionEdge[] | null;
  /** Set of event ids currently visible during a replay; null = all. */
  visibleIds?: ReadonlySet<string> | null;
  /** Optional click handler — fires on atom dot/card click. */
  onAtomClick?: (ev: TimelineEvent) => void;
}

export interface AtomNode {
  ev: TimelineEvent;
  x: number;
  y: number;
}

/**
 * Hash a string to a stable [0, 1) float. djb2 — small + deterministic
 * so test fixtures don't shift atom positions between runs. Used for
 * intra-cell jitter so two atoms by the same actor on the same day
 * don't paint on top of each other.
 */
function hashUnit(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // ((h | 0) >>> 0) coerces to unsigned 32-bit. Divide for [0, 1).
  return ((h | 0) >>> 0) / 4294967296;
}

/** Lay out atoms in canvas-space. Pure helper — exported for tests. */
export function layoutAtoms(
  events: TimelineEvent[],
  geom: ReturnType<typeof computeHeatmapGeometry>,
): AtomNode[] {
  const out: AtomNode[] = [];
  // Group by (day, actor) so we can spread atoms within a cell. Same-
  // thread atoms get pulled toward a thread-specific anchor inside
  // the cell so they cluster visibly.
  const byCell = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    const day = (ev.ts || "").slice(0, 10);
    const actor = (ev.actor || "?").toLowerCase();
    const key = `${day}|${actor}`;
    let bucket = byCell.get(key);
    if (!bucket) {
      bucket = [];
      byCell.set(key, bucket);
    }
    bucket.push(ev);
  }
  for (const [key, bucket] of byCell) {
    const [day, actor] = key.split("|");
    const corner = geom.cellCorner(day, actor);
    if (!corner) continue;
    const cx = corner.x + geom.cellSize / 2;
    const cy = corner.y + geom.cellSize / 2;
    // Within the cell, separate atoms with a deterministic jitter
    // anchored on the thread key so same-thread atoms cluster on the
    // same side. Radius capped to ~⅓ cell size so dots stay inside.
    const radius = Math.max(2, geom.cellSize / 3);
    for (const ev of bucket) {
      const tk = threadKeyOf(ev) || "__solo__";
      const angle = hashUnit(tk + ":angle") * 2 * Math.PI;
      const r = radius * (0.4 + 0.6 * hashUnit(ev.id + ":r"));
      const dx = Math.cos(angle) * r * 0.55;
      const dy = Math.sin(angle) * r * 0.55;
      // Per-atom additional micro-jitter so two atoms in the same
      // thread+cell still separate (fan within the cluster).
      const mdx = (hashUnit(ev.id + ":mx") - 0.5) * radius * 0.5;
      const mdy = (hashUnit(ev.id + ":my") - 0.5) * radius * 0.5;
      out.push({ ev, x: cx + dx + mdx, y: cy + dy + mdy });
    }
  }
  return out;
}

export function AtomLayer({
  events,
  days = 30,
  anchorMs,
  cellSize = 18,
  gap = 2,
  opacity = 1,
  showCards = false,
  edges = null,
  visibleIds = null,
  onAtomClick,
}: AtomLayerProps) {
  const geom = useMemo(
    () => computeHeatmapGeometry(events, { days, anchorMs, cellSize, gap }),
    [events, days, anchorMs, cellSize, gap],
  );
  const nodes = useMemo(() => layoutAtoms(events, geom), [events, geom]);
  const nodeById = useMemo(() => {
    const m = new Map<string, AtomNode>();
    for (const n of nodes) m.set(n.ev.id, n);
    return m;
  }, [nodes]);
  // Pre-compute edges if the caller didn't pass them in.
  const computedEdges = useMemo(
    () => edges ?? computeMentionEdges(events),
    [edges, events],
  );

  const isVisible = (id: string): boolean =>
    visibleIds === null ? true : visibleIds.has(id);

  return (
    <g
      data-testid="atom-layer"
      data-atom-count={nodes.length}
      data-edge-count={computedEdges.length}
      style={{ opacity, transition: "opacity 100ms ease-out" }}
      pointerEvents={opacity > 0.05 ? "auto" : "none"}
    >
      {/* Edges first so atoms paint on top. */}
      <g data-testid="atom-edges" stroke="var(--ti-orange-500, #cc5500)">
        {computedEdges.map((e) => {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) return null;
          if (!isVisible(e.from) || !isVisible(e.to)) return null;
          return (
            <line
              key={`${e.from}->${e.to}`}
              data-testid={`mention-edge-${e.from}-${e.to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeOpacity={0.18 + Math.min(0.32, e.weight * 0.08)}
              strokeWidth={1}
            />
          );
        })}
      </g>
      <g data-testid="atom-nodes">
        {nodes.map((n) => {
          if (!isVisible(n.ev.id)) return null;
          const v = vendorFor(n.ev.source);
          if (!showCards) {
            return (
              <circle
                key={n.ev.id}
                data-testid={`atom-dot-${n.ev.id}`}
                data-vendor={v.display}
                cx={n.x}
                cy={n.y}
                r={2.4}
                fill={v.color}
                onClick={onAtomClick ? () => onAtomClick(n.ev) : undefined}
              >
                <title>
                  {`${n.ev.actor || "?"} · ${(n.ev.ts || "").slice(0, 10)} · ${v.display}`}
                </title>
              </circle>
            );
          }
          // Show-card path: a 96×56 rounded rect with the vendor dot,
          // actor name, and first non-empty body line. Painted at full
          // zoom so the text is legible.
          const body = n.ev.body ?? "";
          const preview =
            body
              .split("\n")
              .map((l) => l.trim())
              .find((l) => l.length > 0) ?? n.ev.kind ?? "(no body)";
          const truncated =
            preview.length > 48 ? preview.slice(0, 48) + "…" : preview;
          const cardW = 96;
          const cardH = 56;
          return (
            <g
              key={n.ev.id}
              data-testid={`atom-card-${n.ev.id}`}
              data-vendor={v.display}
              transform={`translate(${n.x - cardW / 2}, ${n.y - cardH / 2})`}
              onClick={onAtomClick ? () => onAtomClick(n.ev) : undefined}
              style={{ cursor: onAtomClick ? "pointer" : "default" }}
            >
              <rect
                width={cardW}
                height={cardH}
                rx={4}
                ry={4}
                fill="white"
                stroke="rgb(231 229 228)"
                strokeWidth={1}
              />
              <rect width={3} height={cardH} fill={v.color} rx={1.5} ry={1.5} />
              <circle cx={12} cy={10} r={3} fill={v.color} />
              <text
                x={20}
                y={12}
                fontSize={9}
                fill="#44403c"
                fontWeight={600}
              >
                {truncate(n.ev.actor || "?", 12)}
              </text>
              <text
                x={6}
                y={26}
                fontSize={8}
                fill="#57534e"
              >
                {truncate(truncated, 18)}
              </text>
              <text
                x={6}
                y={38}
                fontSize={7}
                fill="#a8a29e"
                fontFamily="ui-monospace, monospace"
              >
                {(n.ev.ts || "").slice(11, 16)}
              </text>
            </g>
          );
        })}
      </g>
    </g>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export default AtomLayer;
