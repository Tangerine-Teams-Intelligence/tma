import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Diamond as DiamondIcon,
  FileText,
  GitPullRequest,
  Hash,
  MessageSquare,
} from "lucide-react";

import { listAtoms, type AtomEntry } from "@/lib/atoms";
import { useStore } from "@/lib/store";
import { layoutGraph, basenameSlug } from "./graphLayout";

/**
 * v2.0-beta.1 — Decision Lineage Tree (V2_0_SPEC §2.2).
 *
 * Per atom of kind=decisions we materialise a directed tree:
 *
 *   source atoms (meetings / threads / prior decisions / canvas drafts)
 *        │
 *        ▼
 *   decision atom  (root — orange diamond, the thing we drilled into)
 *        │
 *        ▼
 *   writeback targets (GitHub PR, Linear issue, Slack post, doc commit)
 *
 * v2.0-alpha.2 had this implicit in the home WorkflowGraph as substring-
 * matched mention edges. v2.0-beta.1 promotes lineage to a first-class
 * surface by reading two pieces of frontmatter on each decision atom:
 *
 *   ---
 *   source_provenance:
 *     - meetings/2026-04-25-roadmap.md
 *     - threads/pricing.md
 *   writeback:
 *     - github://Tangerine-Intelligence/legal-documents#PR-42
 *     - linear://TI-218
 *     - slack://#leads/1714502400.123456
 *   ---
 *
 * `source_provenance` is canonical (canvas_writer.rs already emits it for
 * Stage-1 atoms). `writeback` was introduced in v1.9 P3-A — see
 * SUGGESTION_ENGINE_SPEC §3.2. Either may be missing; the tree degrades
 * gracefully (lone diamond with no parents/children) rather than throwing.
 *
 * Layout: dagre-shaped via `graphLayout.layoutGraph`. Each atom row gets
 * one rank below its deepest parent, so the visual cascades top-to-bottom
 * even when a single decision pulls from 4 prior atoms.
 *
 * Test-friendly: `buildLineageGraph(atoms, bodies)` is a pure function
 * exported alongside the component. The component reads `bodies` lazily
 * via Tauri fs in production; outside Tauri the lazy reader resolves to
 * an empty map and the builder still produces a valid lone-diamond tree.
 */
export function DecisionLineageTree() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.ui.currentUser);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const [atoms, setAtoms] = useState<AtomEntry[] | null>(null);
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // 1. Load atoms (kind=decisions only — the rest are materialised as
  //    parent placeholders if their rel_path appears in source_provenance,
  //    so we don't pay to read every meeting + thread frontmatter for
  //    surfaces the lineage builder won't ever connect to.)
  useEffect(() => {
    let cancel = false;
    void listAtoms({
      current_user: currentUser,
      include_personal: true,
    })
      .then((r) => {
        if (cancel) return;
        setAtoms(r.atoms);
      })
      .catch((e) => {
        if (cancel) return;
        setError(String(e));
        setAtoms([]);
      });
    return () => {
      cancel = true;
    };
  }, [currentUser]);

  // 2. Lazy frontmatter read for every decision atom. We only need the
  //    first ~2KB to reach the closing `---`, but `readTextFile` doesn't
  //    expose a byte-range API — full reads are still cheap (<10KB each)
  //    relative to the 500ms render budget.
  useEffect(() => {
    if (atoms === null) return;
    let cancel = false;
    const decisions = atoms.filter((a) => a.kind === "decisions");
    if (decisions.length === 0) {
      setBodies(new Map());
      return;
    }
    void readBodies(memoryRoot, decisions).then((map) => {
      if (cancel) return;
      setBodies(map);
    });
    return () => {
      cancel = true;
    };
  }, [atoms, memoryRoot]);

  const { nodes, edges } = useMemo(
    () => buildLineageGraph(atoms ?? [], bodies),
    [atoms, bodies],
  );

  const onNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      const data = node.data as LineageNodeData | undefined;
      if (!data) return;
      const target = lineageDetailRoute(data);
      if (target) navigate(target);
    },
    [navigate],
  );

  const nodeTypes = useMemo(
    () => ({
      "lineage-source": SourceNode,
      "lineage-decision": DecisionNode,
      "lineage-writeback": WritebackNode,
    }),
    [],
  );

  if (atoms === null) {
    return (
      <div
        data-testid="lineage-tree-loading"
        aria-busy="true"
        aria-label="Decision lineage loading"
        className="relative h-[480px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      >
        <div className="absolute inset-x-0 top-12 flex justify-center">
          <div className="h-9 w-9 rotate-45 animate-pulse rounded-sm bg-[var(--ti-paper-200)]" />
        </div>
        <div className="absolute inset-x-0 top-32 flex justify-center gap-12">
          <div className="h-8 w-24 animate-pulse rounded-md bg-[var(--ti-paper-200)]" />
          <div className="h-8 w-24 animate-pulse rounded-md bg-[var(--ti-paper-200)]" />
        </div>
        <div className="absolute inset-x-0 top-52 flex justify-center gap-6">
          <div className="h-8 w-20 animate-pulse rounded-md bg-[var(--ti-paper-200)]" />
          <div className="h-8 w-24 animate-pulse rounded-md bg-[var(--ti-paper-200)]" />
          <div className="h-8 w-20 animate-pulse rounded-md bg-[var(--ti-paper-200)]" />
        </div>
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Loading lineage…
        </p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return <LineageEmpty error={error} />;
  }

  return (
    <div
      data-testid="lineage-tree"
      className="h-[640px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      role="region"
      aria-label="Decision lineage tree"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        {nodes.length >= 20 && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

function LineageEmpty({ error }: { error: string | null }) {
  return (
    <div
      data-testid="lineage-tree-empty"
      className="flex h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50/50 px-6 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <p className="text-[13px] font-medium text-stone-700 dark:text-stone-200">
        No decision atoms yet
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
        Decisions are written by the canvas writer, the suggestion engine,
        and the Discord/Slack source pipelines. Once one lands here you'll
        see its source meetings + writeback targets fan out as a tree.
      </p>
      {error && (
        <p className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node + edge schema
// ---------------------------------------------------------------------------

export type LineageNodeKind = "source" | "decision" | "writeback";

export interface LineageNodeData {
  kind: LineageNodeKind;
  label: string;
  /** Atom rel_path (source / decision) or external URI (writeback). */
  ref: string;
  /** Subtype hint for sources / writebacks ("meeting", "github", …). */
  flavor?: string;
  /** Optional secondary label rendered under the primary one. */
  sub?: string;
}

interface BuiltGraph {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Pure builder — accepts the atom list + a map of {rel_path → file body}
 * for decision atoms only. Returns reactflow-shaped nodes + edges.
 *
 * Source-atom nodes are synthesised from the rel_paths referenced in
 * `source_provenance:`. We do not require the target rel_path to exist
 * in `atoms` — a decision atom that points at `meetings/2026-04-25-foo.md`
 * still gets a parent node even when that file is gone (deleted, moved).
 */
export function buildLineageGraph(
  atoms: AtomEntry[],
  bodies: Map<string, string>,
): BuiltGraph {
  const builder = new LineageBuilder(atoms);
  for (const a of atoms) {
    if (a.kind !== "decisions") continue;
    const body = bodies.get(a.rel_path) ?? "";
    builder.absorb(a, body);
  }
  return builder.materialize();
}

class LineageBuilder {
  private nodes = new Map<string, LineageNodeData>();
  private edges: { source: string; target: string; kind: string }[] = [];
  private atomsByPath: Map<string, AtomEntry>;

  constructor(atoms: AtomEntry[]) {
    this.atomsByPath = new Map(atoms.map((a) => [a.rel_path, a]));
  }

  absorb(a: AtomEntry, body: string): void {
    const decisionId = `decision:${basenameSlug(a.name)}`;
    this.upsertNode(decisionId, {
      kind: "decision",
      label: prettyDecisionLabel(basenameSlug(a.name)),
      ref: a.rel_path,
      sub: a.rel_path,
    });

    const fm = parseFrontmatter(body);

    // Parents — every entry in `source_provenance:` is a source node.
    for (const ref of fm.source_provenance) {
      const id = `source:${ref}`;
      this.upsertNode(id, {
        kind: "source",
        label: refLabel(ref),
        ref,
        flavor: refFlavor(this.atomsByPath.get(ref)?.kind, ref),
      });
      this.edges.push({ source: id, target: decisionId, kind: "derived_from" });
    }

    // Children — `writeback:` URIs become writeback leaves.
    for (const target of fm.writeback) {
      const id = `writeback:${target}`;
      this.upsertNode(id, {
        kind: "writeback",
        label: writebackLabel(target),
        ref: target,
        flavor: writebackFlavor(target),
      });
      this.edges.push({ source: decisionId, target: id, kind: "writeback" });
    }
  }

  private upsertNode(id: string, data: LineageNodeData): void {
    if (!this.nodes.has(id)) this.nodes.set(id, data);
  }

  materialize(): BuiltGraph {
    const inNodes: { id: string; rank?: number }[] = [];
    for (const [id, data] of this.nodes) {
      // Rank seed so we never end up with all nodes on rank 0 in the no-edge
      // edge case (lone-diamond decision with no provenance / writeback).
      const rank =
        data.kind === "source" ? 0 : data.kind === "decision" ? 1 : 2;
      inNodes.push({ id, rank });
    }
    const inEdges = this.edges.map((e) => ({ source: e.source, target: e.target }));
    const positions = layoutGraph(inNodes, inEdges, { ySpacing: 160 });
    const posById = new Map(positions.map((p) => [p.id, p.position]));

    const nodes: Node[] = [];
    for (const [id, data] of this.nodes) {
      nodes.push({
        id,
        type: `lineage-${data.kind}`,
        data,
        position: posById.get(id) ?? { x: 0, y: 0 },
      });
    }
    const edges: Edge[] = this.edges.map((e, i) => ({
      id: `e${i}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      type: "default",
      animated: false,
      style: edgeStyle(e.kind),
      data: { kind: e.kind },
    }));
    return { nodes, edges };
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface LineageFm {
  source_provenance: string[];
  writeback: string[];
}

/**
 * Parse the two list-shaped frontmatter fields we care about. We do not
 * depend on a real YAML parser to keep the bundle small and to match the
 * existing `parseFrontmatter` helper in `lib/memory.ts` (string-only).
 *
 * Recognised shapes:
 *
 *     source_provenance:
 *       - path/to/foo.md
 *       - path/to/bar.md
 *
 *     writeback:
 *       - github://owner/repo#PR-42
 *
 *     # also accepted (inline JSON-ish):
 *     source_provenance: [path/to/foo.md, path/to/bar.md]
 */
export function parseFrontmatter(body: string): LineageFm {
  const out: LineageFm = { source_provenance: [], writeback: [] };
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const fm = m[1];

  // Parse list-style fields. Walk line-by-line; when we hit a `key:` we
  // know to consume subsequent `  - value` lines until the next non-list
  // line. Inline `[a, b]` flow gets a small dedicated branch.
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^(source_provenance|writeback)\s*:\s*\[(.*)\]\s*$/);
    if (inline) {
      const key = inline[1] as keyof LineageFm;
      out[key] = inline[2]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    const block = line.match(/^(source_provenance|writeback)\s*:\s*$/);
    if (block) {
      const key = block[1] as keyof LineageFm;
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j].match(/^\s+-\s+(.+?)\s*$/);
        if (!item) break;
        out[key].push(item[1].replace(/^["']|["']$/g, ""));
        j++;
      }
      i = j - 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tauri fs reader
// ---------------------------------------------------------------------------

async function readBodies(
  root: string,
  atoms: AtomEntry[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return map;
  }
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    await Promise.all(
      atoms.map(async (a) => {
        try {
          const abs =
            root.endsWith("/") || root.endsWith("\\")
              ? root + a.rel_path
              : `${root}/${a.rel_path}`;
          const text = await fs.readTextFile(abs);
          map.set(a.rel_path, text);
        } catch {
          /* missing / unreadable atom — leave it absent */
        }
      }),
    );
  } catch {
    /* plugin-fs not available — leave map empty */
  }
  return map;
}

// ---------------------------------------------------------------------------
// Label / flavor helpers
// ---------------------------------------------------------------------------

function prettyDecisionLabel(slug: string): string {
  const withoutDate = slug.replace(/^\d{4}-\d{2}(?:-\d{2})?-?/, "");
  const cleaned = withoutDate.replace(/[-_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 40) : slug;
}

function refLabel(ref: string): string {
  const tail = ref.split("/").pop() ?? ref;
  return tail.replace(/\.(md|markdown|mdx)$/i, "").slice(0, 32);
}

function refFlavor(kind: string | undefined, ref: string): string {
  if (kind) return kind;
  if (ref.includes("/meetings/")) return "meetings";
  if (ref.includes("/threads/")) return "threads";
  if (ref.includes("/canvas/")) return "canvas";
  return "atom";
}

function writebackLabel(uri: string): string {
  // github://owner/repo#PR-42 → "PR-42"
  // linear://TI-218         → "TI-218"
  // slack://#chan/12345.6   → "#chan"
  const hash = uri.lastIndexOf("#");
  if (hash >= 0) {
    const tail = uri.slice(hash + 1);
    return tail.split("/")[0].slice(0, 24);
  }
  const path = uri.replace(/^\w+:\/\//, "");
  return path.split("/").pop()?.slice(0, 24) ?? uri.slice(0, 24);
}

function writebackFlavor(uri: string): string {
  const m = uri.match(/^(\w+):\/\//);
  return m ? m[1] : "writeback";
}

function edgeStyle(kind: string): React.CSSProperties {
  switch (kind) {
    case "derived_from":
      return { stroke: "var(--ti-ink-700, #6b7280)" };
    case "writeback":
      return { stroke: "var(--ti-orange-500, #CC5500)", strokeWidth: 1.5 };
    default:
      return { stroke: "var(--ti-ink-700, #6b7280)" };
  }
}

function lineageDetailRoute(data: LineageNodeData): string | null {
  switch (data.kind) {
    case "source":
    case "decision":
      return `/memory/${encodeURI(data.ref)}`;
    case "writeback":
      // Writeback URIs aren't local atoms; we don't navigate (the user
      // can right-click open URL externally once we wire that). Returning
      // null cancels the click handler.
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Custom node components
// ---------------------------------------------------------------------------

function SourceNode({ data }: NodeProps<LineageNodeData>) {
  const Icon = sourceIcon(data.flavor);
  return (
    <div
      data-testid={`lineage-node-source-${basenameSlug(data.ref)}`}
      className="flex min-w-[150px] items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-[12px] shadow-sm dark:border-stone-600 dark:bg-stone-900"
      title={data.ref}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Icon size={12} className="shrink-0 text-stone-500" aria-hidden />
      <span className="truncate font-medium text-stone-800 dark:text-stone-100">
        {data.label}
      </span>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function DecisionNode({ data }: NodeProps<LineageNodeData>) {
  return (
    <div
      data-testid={`lineage-node-decision-${basenameSlug(data.ref)}`}
      className="relative h-[88px] w-[170px]"
      title={data.sub ?? data.label}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: "rotate(45deg)" }}
      >
        <div className="h-[72px] w-[72px] bg-[var(--ti-orange-500,#CC5500)] shadow-sm" />
      </div>
      <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
        <div className="flex items-center gap-1">
          <DiamondIcon size={11} className="text-white" aria-hidden />
          <span className="line-clamp-2 text-[11px] font-semibold leading-tight text-white">
            {data.label}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function WritebackNode({ data }: NodeProps<LineageNodeData>) {
  const Icon = writebackIcon(data.flavor);
  return (
    <div
      data-testid={`lineage-node-writeback-${data.flavor}-${basenameSlug(data.label)}`}
      className="flex min-w-[140px] items-center gap-2 rounded-sm border-l-4 border-[var(--ti-success,#2D8F4E)] bg-stone-100 px-3 py-2 text-[12px] shadow-sm dark:bg-stone-800"
      title={data.ref}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Icon size={12} className="text-[var(--ti-success,#2D8F4E)]" aria-hidden />
      <span className="truncate font-medium text-stone-800 dark:text-stone-100">
        {data.label}
      </span>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function sourceIcon(flavor?: string) {
  switch (flavor) {
    case "meetings":
      return MessageSquare;
    case "threads":
      return Hash;
    default:
      return FileText;
  }
}

function writebackIcon(flavor?: string) {
  switch (flavor) {
    case "github":
      return GitPullRequest;
    case "slack":
      return MessageSquare;
    case "linear":
      return Hash;
    default:
      return FileText;
  }
}

export default DecisionLineageTree;
