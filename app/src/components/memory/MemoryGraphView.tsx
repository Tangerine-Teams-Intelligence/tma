// === wave 23 ===
/**
 * Wave 23 — Visual atom graph view for the /memory route.
 *
 * Renders one node per atom, with edges for cites / same_author /
 * same_vendor / same_project relationships pulled from the new
 * `memory_graph_data` Tauri command. Reactflow handles pan/zoom/drag and
 * we do our own cluster-based positioning (no extra dep — keeps the
 * bundle slim and is plenty for the ~100-node default subset).
 *
 * Toolbar:
 *   - Search (debounced 200ms) — substring match on title or path.
 *     Matching nodes stay opaque, others render at 30% opacity (dim).
 *   - Cluster-by dropdown: vendor (default) / author / project / kind.
 *     Drives the radial cluster layout below.
 *   - Show-all toggle when truncated > default subset.
 *
 * Performance:
 *   - Default subset = 100 most-recent atoms (timestamp desc, fall back
 *     to insertion order). The `Show all` toggle lifts the cap to the
 *     Rust-side GRAPH_MAX_NODES (1000).
 *   - Reactflow's built-in viewport virtualization handles off-screen
 *     nodes — we don't pass `onlyRenderVisibleElements` because pannable
 *     edges look bad when their endpoints disappear.
 *   - Cluster layout is O(N) — group by key, lay out groups around a
 *     ring, members around a per-group sub-ring.
 *
 * Defensive: empty memory dir / single atom / no edges → render the
 * friendly empty state with "Add a note to see the graph".
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";

import { memoryGraphData, type AtomGraphData } from "@/lib/tauri";
import { vendorColor } from "@/lib/vendor-colors";
import { AtomGraphNode, type AtomGraphNodeData } from "./AtomGraphNode";

interface Props {
  /** Currently-selected file path (rel to memory root). Highlights the node. */
  selectedPath: string | null;
  /** Fired when the user clicks a node. */
  onSelect: (path: string) => void;
  /** Optional vendor filter id (for the chip strip). */
  vendorFilter?: string | null;
  /** Optional kind filter (e.g. "decisions"). */
  kindFilter?: string | null;
}

type ClusterKey = "vendor" | "author" | "project" | "kind";

const DEFAULT_SUBSET = 100;

// Hoisted nodeTypes — same trick as WorkflowGraph so the prop identity stays
// stable across renders and reactflow doesn't fire its "new nodeTypes" warning.
const NODE_TYPES = { atom: AtomGraphNode } as const;

export function MemoryGraphView({
  selectedPath,
  onSelect,
  vendorFilter,
  kindFilter,
}: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<AtomGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [clusterBy, setClusterBy] = useState<ClusterKey>("vendor");
  const [showAll, setShowAll] = useState(false);

  // Debounce search so each keystroke doesn't redrive the cluster layout.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => window.clearTimeout(id);
  }, [search]);

  // Fetch the graph from the Rust side. Re-fetch whenever the Rust-side
  // filters (vendor/kind) change. The search-side dim is a pure client
  // operation so it doesn't roundtrip.
  useEffect(() => {
    let cancel = false;
    setError(null);
    void memoryGraphData({
      vendor: vendorFilter ?? undefined,
      kind: kindFilter ?? undefined,
    })
      .then((d) => {
        if (cancel) return;
        setData(d);
      })
      .catch((e) => {
        if (cancel) return;
        setError(String(e));
        setData({ nodes: [], edges: [], truncated: false });
      });
    return () => {
      cancel = true;
    };
  }, [vendorFilter, kindFilter]);

  // Build the reactflow node + edge set. Subset to most-recent N (or all if
  // showAll is on), cluster-position by the chosen key, dim non-search hits.
  const { nodes, edges, totalCount, visibleCount } = useMemo(() => {
    if (!data) return { nodes: [], edges: [], totalCount: 0, visibleCount: 0 };
    const sorted = [...data.nodes].sort((a, b) => {
      const ta = a.timestamp ?? "";
      const tb = b.timestamp ?? "";
      // Descending — newest first.
      if (ta && tb) return tb.localeCompare(ta);
      if (ta) return -1;
      if (tb) return 1;
      return 0;
    });
    const limit = showAll ? sorted.length : Math.min(DEFAULT_SUBSET, sorted.length);
    const subset = sorted.slice(0, limit);
    const subsetIds = new Set(subset.map((n) => n.id));
    const positions = clusterLayout(subset, clusterBy);
    const lc = debouncedSearch.toLowerCase();
    const isMatch = (label: string, path: string): boolean => {
      if (lc.length === 0) return true;
      return label.toLowerCase().includes(lc) || path.toLowerCase().includes(lc);
    };
    const rfNodes: Node<AtomGraphNodeData>[] = subset.map((n) => {
      const nodeData: AtomGraphNodeData = {
        label: n.label,
        vendor: n.vendor,
        author: n.author,
        kind: n.kind,
        path: n.id,
        project: n.project,
        dimmed: lc.length > 0 && !isMatch(n.label, n.id),
      };
      return {
        id: n.id,
        type: "atom",
        data: nodeData,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        selected: n.id === selectedPath,
      };
    });
    const rfEdges: Edge[] = data.edges
      .filter((e) => subsetIds.has(e.source) && subsetIds.has(e.target))
      .map((e, i) => ({
        id: `e${i}-${e.source}-${e.target}-${e.kind}`,
        source: e.source,
        target: e.target,
        type: "default",
        animated: false,
        style: edgeStyleForKind(e.kind, e.weight),
        data: { kind: e.kind },
      }));
    return {
      nodes: rfNodes,
      edges: rfEdges,
      totalCount: data.nodes.length,
      visibleCount: subset.length,
    };
  }, [data, debouncedSearch, clusterBy, selectedPath, showAll]);

  if (data === null) {
    return (
      <div
        data-testid="memory-graph-loading"
        className="flex h-full items-center justify-center"
      >
        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Loading graph…
        </p>
      </div>
    );
  }

  if (data.nodes.length === 0) {
    return (
      <div
        data-testid="memory-graph-empty"
        className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <p className="text-sm text-stone-700 dark:text-stone-200">
          {t("memory.graph.emptyTitle", { defaultValue: "No atoms yet." })}
        </p>
        <p className="max-w-md text-[12px] text-stone-500 dark:text-stone-400">
          {t("memory.graph.emptyBody", {
            defaultValue: "Add a note to see the graph.",
          })}
        </p>
        {error && (
          <p className="font-mono text-[10px] text-stone-400">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="memory-graph-view"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      <div
        data-testid="memory-graph-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-200 px-3 dark:border-stone-800"
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("memory.graph.searchPlaceholder", {
            defaultValue: "Search nodes…",
          })}
          aria-label="Search atom graph"
          data-testid="memory-graph-search"
          className="w-44 rounded border border-stone-200 bg-white px-2 py-1 font-mono text-[11px] text-stone-700 outline-none focus:border-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
        />
        <label className="flex items-center gap-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
          {t("memory.graph.clusterBy", { defaultValue: "Cluster by" })}
          <select
            value={clusterBy}
            onChange={(e) => setClusterBy(e.target.value as ClusterKey)}
            data-testid="memory-graph-cluster-select"
            className="rounded border border-stone-200 bg-white px-1 py-0.5 text-[11px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
          >
            <option value="vendor">
              {t("memory.graph.clusterVendor", { defaultValue: "Vendor" })}
            </option>
            <option value="author">
              {t("memory.graph.clusterAuthor", { defaultValue: "Author" })}
            </option>
            <option value="project">
              {t("memory.graph.clusterProject", { defaultValue: "Project" })}
            </option>
            <option value="kind">
              {t("memory.graph.clusterKind", { defaultValue: "Kind" })}
            </option>
          </select>
        </label>
        <p className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500">
          {visibleCount}/{totalCount}
          {data.truncated ? "+" : ""}
        </p>
        {totalCount > DEFAULT_SUBSET && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            data-testid="memory-graph-show-all"
            className="rounded border border-stone-200 bg-white px-2 py-0.5 font-mono text-[10px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
            aria-pressed={showAll}
          >
            {showAll
              ? t("memory.graph.showRecent", { defaultValue: "Show recent" })
              : t("memory.graph.showAll", { defaultValue: "Show all" })}
          </button>
        )}
      </div>

      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={(_evt, node) => {
            const d = node.data as AtomGraphNodeData | undefined;
            if (d?.path) onSelect(d.path);
          }}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          {nodes.length >= 30 && <MiniMap pannable zoomable />}
        </ReactFlow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge styling
// ---------------------------------------------------------------------------

function edgeStyleForKind(kind: string, weight: number): React.CSSProperties {
  // Strong cites edge — solid orange. Same-author/vendor/project edges are
  // light dashed lines with a vendor-neutral grey so the graph stays
  // readable.
  switch (kind) {
    case "cites":
      return {
        stroke: "var(--ti-orange-500, #CC5500)",
        strokeWidth: Math.max(1, weight * 1.5),
        opacity: 0.85,
      };
    case "same_project":
      return {
        stroke: "#7C3AED",
        strokeWidth: 1,
        opacity: 0.4,
        strokeDasharray: "3 4",
      };
    case "same_author":
      return {
        stroke: "#6b7280",
        strokeWidth: 1,
        opacity: 0.25,
        strokeDasharray: "2 4",
      };
    case "same_vendor":
    default:
      return {
        stroke: "#9ca3af",
        strokeWidth: 1,
        opacity: 0.2,
        strokeDasharray: "1 5",
      };
  }
}

// ---------------------------------------------------------------------------
// Cluster layout — groups by `clusterBy` key, lays groups around a ring,
// members around per-group sub-rings. O(N) and predictable; no force sim.
// ---------------------------------------------------------------------------

interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

function clusterLayout(
  nodes: { id: string; vendor: string | null; author: string | null; project: string | null; kind: string }[],
  clusterBy: ClusterKey,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return out;

  // Group by chosen key.
  const groups = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const raw = pickKey(n, clusterBy);
    const key = raw && raw.length > 0 ? raw : "(none)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  const groupKeys = Array.from(groups.keys()).sort();
  const groupCount = groupKeys.length;

  // Layout constants — tuned to 100-node default subset on a ~900px
  // viewport. Reactflow's fitView reframes regardless so absolute scale
  // is mostly cosmetic.
  const RING_RADIUS = Math.max(280, 80 * Math.sqrt(nodes.length));
  const MEMBER_RADIUS = 60;
  const MEMBER_RADIUS_GROW = 22;

  for (let g = 0; g < groupCount; g++) {
    const key = groupKeys[g];
    const members = groups.get(key)!;
    const angle = (g / Math.max(1, groupCount)) * 2 * Math.PI;
    const cx = Math.cos(angle) * RING_RADIUS;
    const cy = Math.sin(angle) * RING_RADIUS;

    // Spiral members around the cluster center so dense groups don't clump.
    for (let m = 0; m < members.length; m++) {
      const node = members[m];
      const r = MEMBER_RADIUS + Math.floor(m / 8) * MEMBER_RADIUS_GROW;
      const a = (m / Math.max(1, members.length)) * 2 * Math.PI;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      out.set(node.id, { x, y });
    }
  }
  return out;
}

function pickKey(
  n: { vendor: string | null; author: string | null; project: string | null; kind: string },
  key: ClusterKey,
): string | null {
  switch (key) {
    case "vendor":
      return n.vendor;
    case "author":
      return n.author;
    case "project":
      return n.project;
    case "kind":
      return n.kind;
  }
}

// Re-export type so the test file can import without going through tauri.ts.
export type { PositionedNode };

// Pure helper used by tests — kept here so the cluster layout stays
// inspectable from the unit-test side.
export { clusterLayout, pickKey, edgeStyleForKind, vendorColor };
// === end wave 23 ===
