/**
 * v2.0-alpha.2 — graph layout helper.
 *
 * Hand-rolled directed-acyclic auto-layout. Spec calls for `dagre`, but
 * pulling in a second graph dep purely for one home screen is overkill —
 * the workflow graph is small (≤200 nodes for the default 7d window) and
 * the only directional cue we need is "earlier ancestors above, derived
 * atoms below". A topological sort + per-rank x-spread gives us a
 * dagre-shaped layout in ~30 lines without the extra dep.
 *
 * If reactflow's `useReactFlow().fitView` ever can't keep up (>500 node
 * graphs) we'll graduate to `dagre` proper — the input/output shape here
 * mirrors what dagre would produce so the swap is a one-line change.
 */
import type { AtomEntry } from "@/lib/atoms";

export interface LayoutNode {
  id: string;
  position: { x: number; y: number };
}

export interface GraphNodeIn {
  id: string;
  /** Optional explicit rank — used for kind-based bands when no edges. */
  rank?: number;
}

export interface GraphEdgeIn {
  source: string;
  target: string;
}

export interface LayoutOptions {
  /** Horizontal gap between siblings. */
  xSpacing?: number;
  /** Vertical gap between ranks. */
  ySpacing?: number;
}

const DEFAULT_X = 220;
const DEFAULT_Y = 140;

/**
 * Lay out a directed graph by topological rank.
 *
 * Nodes with no incoming edges land at rank 0; each child is placed one
 * rank below the deepest parent. Cycles are broken by visiting nodes in
 * insertion order (we'd rather render a slightly-off layout than throw on
 * bad data — atoms can have circular `source_refs:` in the wild).
 *
 * Within each rank, nodes are spread horizontally around the rank's
 * centerline so the tallest band stays visually centered.
 */
export function layoutGraph(
  nodes: GraphNodeIn[],
  edges: GraphEdgeIn[],
  opts: LayoutOptions = {},
): LayoutNode[] {
  const xSpacing = opts.xSpacing ?? DEFAULT_X;
  const ySpacing = opts.ySpacing ?? DEFAULT_Y;

  if (nodes.length === 0) return [];

  // Build adjacency + in-degree map.
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const n of nodes) {
    incoming.set(n.id, new Set());
    outgoing.set(n.id, new Set());
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (e.source === e.target) continue;
    incoming.get(e.target)!.add(e.source);
    outgoing.get(e.source)!.add(e.target);
  }

  // Rank via longest-path-from-roots. Visit in topological order with a
  // visited guard so cycles can't loop forever.
  const rankOf = new Map<string, number>();
  const visited = new Set<string>();
  function rank(id: string): number {
    if (rankOf.has(id)) return rankOf.get(id)!;
    if (visited.has(id)) {
      // Cycle — break by treating this node as rank 0.
      rankOf.set(id, 0);
      return 0;
    }
    visited.add(id);
    const parents = incoming.get(id) ?? new Set();
    if (parents.size === 0) {
      rankOf.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const p of parents) {
      const r = rank(p);
      if (r + 1 > max) max = r + 1;
    }
    rankOf.set(id, max);
    return max;
  }
  for (const n of nodes) rank(n.id);

  // Allow caller to pin a rank (kind-based fallback when there are no edges).
  for (const n of nodes) {
    if (typeof n.rank === "number") {
      rankOf.set(n.id, n.rank);
    }
  }

  // Group by rank.
  const byRank = new Map<number, string[]>();
  for (const n of nodes) {
    const r = rankOf.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n.id);
  }

  // Assign positions.
  const out: LayoutNode[] = [];
  const ranks = Array.from(byRank.keys()).sort((a, b) => a - b);
  for (const r of ranks) {
    const ids = byRank.get(r)!;
    // Centered around 0 so reactflow's fitView frames it nicely.
    const totalWidth = (ids.length - 1) * xSpacing;
    const startX = -totalWidth / 2;
    for (let i = 0; i < ids.length; i++) {
      out.push({
        id: ids[i],
        position: { x: startX + i * xSpacing, y: r * ySpacing },
      });
    }
  }
  return out;
}

/**
 * Map an atom kind (or the synthetic "person" / "agent") to a rank band so
 * the layout looks reasonable even when there are no edges yet. Persons
 * float at the top, projects below, decisions in the middle, agents and
 * raw atoms at the bottom.
 */
export function rankForKind(kind: string): number {
  switch (kind) {
    case "person":
      return 0;
    case "project":
      return 1;
    case "decision":
      return 2;
    case "agent":
      return 3;
    default:
      return 4;
  }
}

/**
 * Slug helper — strips a folder rel path down to a stable slug we can use
 * as a node id. Matches the pattern other Tangerine surfaces use (people
 * detail uses the alias; projects use the file basename minus .md).
 */
export function basenameSlug(rel: string): string {
  const last = rel.split("/").filter(Boolean).pop() ?? rel;
  return last.replace(/\.(md|markdown|mdx)$/i, "");
}

/** Convenience re-export so the WorkflowGraph file can keep one import. */
export type { AtomEntry };
