/**
 * v1.18.0 — Pure bucketing helpers shared by HeatmapLayer + AtomLayer.
 *
 * The canvas is a 2-axis grid: time on X (oldest left, newest right),
 * people on Y (busiest at top). The same coord math is used by both
 * layers so a cell at zoom-out and the atoms inside it at zoom-in line
 * up exactly — when the heat-map fades into the atom layer, atoms
 * cluster around their parent cell's centroid instead of jumping.
 *
 * No LLM, no side effects. All functions are pure / deterministic so
 * the tests can pin behaviour without timer mocking.
 */

import type { TimelineEvent } from "@/lib/views";

/** ISO date (YYYY-MM-DD) bucketing helper. */
export function dayKeyOf(ts: string | null | undefined): string {
  if (!ts) return "";
  return ts.slice(0, 10);
}

/** Event actor falls back to "?" when the daemon couldn't infer one. */
export function actorOf(ev: TimelineEvent): string {
  return (ev.actor || "?").toLowerCase();
}

/**
 * Build a sorted list of unique day keys covering the last `days` days
 * ending today. Calendar days with zero atoms are still included so
 * the heat-map renders an empty cell instead of compressing the axis
 * (a quiet Saturday should look quiet, not invisible).
 */
export function dayAxis(days: number, anchorMs: number = Date.now()): string[] {
  const out: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(anchorMs - i * dayMs).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * People axis — total-activity desc, ties broken alphabetically. Solo
 * users see a single row; multi-user teams fan out top → bottom. Atoms
 * with no actor collapse into the "?" lane at the bottom.
 */
export function peopleAxis(events: TimelineEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    const a = actorOf(ev);
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([k]) => k);
}

export interface CellKey {
  day: string;
  actor: string;
}

export interface HeatmapCell extends CellKey {
  count: number;
  events: TimelineEvent[];
}

/**
 * Bucket events into the (day, actor) grid. Empty cells are absent
 * from the returned map — callers iterate the axes and look up by key
 * so an absent entry renders as a transparent / empty cell.
 *
 * Returns:
 *   cells:   Map keyed by `${day}|${actor}` for O(1) lookup.
 *   max:     largest cell count, used to scale the density ramp.
 */
export interface HeatmapBuckets {
  cells: Map<string, HeatmapCell>;
  max: number;
}

export function bucketHeatmap(events: TimelineEvent[]): HeatmapBuckets {
  const cells = new Map<string, HeatmapCell>();
  let max = 0;
  for (const ev of events) {
    const day = dayKeyOf(ev.ts);
    if (!day) continue;
    const actor = actorOf(ev);
    const key = `${day}|${actor}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { day, actor, count: 0, events: [] };
      cells.set(key, cell);
    }
    cell.count += 1;
    cell.events.push(ev);
    if (cell.count > max) max = cell.count;
  }
  return { cells, max };
}

/** Density buckets for color-coding. 0 → empty, 1-4 → low/mid/high/peak. */
export type DensityBand = 0 | 1 | 2 | 3 | 4;

/**
 * Map a raw count to a 0-4 density band relative to the max in the
 * dataset. Pure — used by both heatmap rendering AND tests so a future
 * tweak to the band edges is pinned. Mirrors GitHub's contribution
 * graph: 0 / quartile 1 / quartile 2 / quartile 3 / quartile 4.
 */
export function densityBand(count: number, max: number): DensityBand {
  if (count <= 0) return 0;
  if (max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Hex fill for each density band. Reads neutral-stone → orange ramp. */
export const BAND_COLORS: Record<DensityBand, string> = {
  0: "transparent",
  1: "#f5f5f4", // stone-100
  2: "#fed7aa", // orange-200
  3: "#f97316", // orange-500
  4: "#9a3412", // orange-800 (the brand-darkest end so peak days pop)
};

/** Body text matches `@<word>`. Mirrors threads/index.tsx + AtomCard. */
export const MENTION_RE = /@([a-z0-9][a-z0-9_.-]*)/gi;

/** Extract sorted lowercase unique mentions from a body. */
export function mentionsOf(body: string | null | undefined): string[] {
  if (!body) return [];
  const set = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    set.add(m[1].toLowerCase());
  }
  return [...set].sort();
}

export interface MentionEdge {
  from: string; // event id
  to: string; // event id
  weight: number; // size of the mention-set intersection
}

/**
 * Pre-compute mention edges between atoms. Two atoms get an edge iff
 * their mention sets overlap by at least one alias. The weight is the
 * size of the intersection so a future heavier-line render can express
 * "these two share a whole thread" vs "these two share one alias".
 *
 * O(n^2) on event count — fine for the v1.18 corpus floor (≤500
 * atoms = 250k pairs). If we ever push past 5k atoms we'll move to a
 * mention-set inverted-index pass; for now the simpler shape ships.
 */
export function computeMentionEdges(events: TimelineEvent[]): MentionEdge[] {
  const sets: { id: string; mentions: Set<string> }[] = events.map((ev) => ({
    id: ev.id,
    mentions: new Set(mentionsOf(ev.body)),
  }));
  const edges: MentionEdge[] = [];
  for (let i = 0; i < sets.length; i += 1) {
    const a = sets[i];
    if (a.mentions.size === 0) continue;
    for (let j = i + 1; j < sets.length; j += 1) {
      const b = sets[j];
      if (b.mentions.size === 0) continue;
      let weight = 0;
      for (const m of a.mentions) if (b.mentions.has(m)) weight += 1;
      if (weight > 0) edges.push({ from: a.id, to: b.id, weight });
    }
  }
  return edges;
}

/** Thread key = sorted mentions joined by `,`. Empty key = uncategorized. */
export function threadKeyOf(ev: TimelineEvent): string {
  return mentionsOf(ev.body).join(",");
}
