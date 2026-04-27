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
import { FolderKanban } from "lucide-react";

import { listAtoms, type AtomEntry } from "@/lib/atoms";
import { useStore } from "@/lib/store";
import { layoutGraph, basenameSlug } from "./graphLayout";

/**
 * v2.0-beta.1 — Project Topology (V2_0_SPEC §2.4).
 *
 * Reads `team/projects/*.md` (and `personal/<user>/projects/` if any),
 * parses two frontmatter fields:
 *
 *     ---
 *     status: active | blocked | done | idle
 *     dependencies:
 *       - other-project-slug
 *       - another-project
 *     ---
 *
 * Projects with no `dependencies:` are roots and land at the top rank.
 * Each child sits one rank below the deepest parent (longest-path layout
 * via `graphLayout.layoutGraph`). Status drives the left-edge color band:
 *
 *   active  → green   (--ti-success)
 *   blocked → red     (--ti-danger)
 *   idle    → amber   (--ti-warn)
 *   done    → gray
 *   <none>  → gray (treated as idle)
 *
 * Click a project node → `/projects/<slug>` (existing detail surface).
 *
 * Pure builder: `buildProjectTopology(atoms, bodies)` — see test file.
 */
export function ProjectTopology() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.ui.currentUser);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const [atoms, setAtoms] = useState<AtomEntry[] | null>(null);
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void listAtoms({
      current_user: currentUser,
      include_personal: true,
      kinds: ["projects"],
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

  useEffect(() => {
    if (atoms === null) return;
    let cancel = false;
    if (atoms.length === 0) {
      setBodies(new Map());
      return;
    }
    void readProjectBodies(memoryRoot, atoms).then((map) => {
      if (cancel) return;
      setBodies(map);
    });
    return () => {
      cancel = true;
    };
  }, [atoms, memoryRoot]);

  const { nodes, edges } = useMemo(
    () => buildProjectTopology(atoms ?? [], bodies),
    [atoms, bodies],
  );

  const onNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      const data = node.data as ProjectNodeData | undefined;
      if (!data) return;
      navigate(`/memory/projects/${encodeURIComponent(data.slug)}`);
    },
    [navigate],
  );

  const nodeTypes = useMemo(() => ({ "topology-project": ProjectNode }), []);

  if (atoms === null) {
    return (
      <div
        data-testid="topology-graph-loading"
        className="flex h-[480px] w-full items-center justify-center rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      >
        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Loading topology…
        </p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return <TopologyEmpty error={error} />;
  }

  return (
    <div
      data-testid="topology-graph"
      className="h-[640px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      role="region"
      aria-label="Project topology"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.25 }}
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

function TopologyEmpty({ error }: { error: string | null }) {
  return (
    <div
      data-testid="topology-graph-empty"
      className="flex h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50/50 px-6 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <p className="text-[13px] font-medium text-stone-700 dark:text-stone-200">
        No projects yet
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
        Add a markdown file under `team/projects/` with `status:` and
        optional `dependencies:` frontmatter and it will show up here.
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
// Schema
// ---------------------------------------------------------------------------

export type ProjectStatus = "active" | "blocked" | "done" | "idle";

export interface ProjectNodeData {
  slug: string;
  label: string;
  status: ProjectStatus;
  ref: string;
}

interface BuiltTopology {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Pure builder. Each project becomes a node; `dependencies: [slug]`
 * frontmatter generates a `dep → project` edge. Unknown dependency
 * slugs are silently dropped (the project file may have been removed).
 */
export function buildProjectTopology(
  atoms: AtomEntry[],
  bodies: Map<string, string>,
): BuiltTopology {
  // 1. Build slug → AtomEntry map. We canonicalise on `basenameSlug` so
  //    `dependencies: [v1-launch]` resolves to `team/projects/v1-launch.md`
  //    regardless of which scope the file lives in.
  const bySlug = new Map<string, AtomEntry>();
  for (const a of atoms) {
    if (a.kind !== "projects") continue;
    bySlug.set(basenameSlug(a.name), a);
  }

  // 2. Build node + edge lists.
  const nodeData = new Map<string, ProjectNodeData>();
  const edgeList: { source: string; target: string }[] = [];

  for (const [slug, a] of bySlug) {
    const fm = parseProjectFm(bodies.get(a.rel_path) ?? "");
    const id = `project:${slug}`;
    nodeData.set(id, {
      slug,
      label: prettyProjectLabel(slug),
      status: fm.status,
      ref: a.rel_path,
    });
    for (const dep of fm.dependencies) {
      const depSlug = basenameSlug(dep);
      if (!bySlug.has(depSlug)) continue;
      edgeList.push({ source: `project:${depSlug}`, target: id });
    }
  }

  // 3. Layout — hierarchical via the shared dagre helper. Roots (no
  //    incoming edges) end up at rank 0 (top).
  const inNodes = Array.from(nodeData.keys()).map((id) => ({ id }));
  const positions = layoutGraph(inNodes, edgeList, {
    xSpacing: 220,
    ySpacing: 160,
  });
  const posById = new Map(positions.map((p) => [p.id, p.position]));

  const nodes: Node[] = [];
  for (const [id, data] of nodeData) {
    nodes.push({
      id,
      type: "topology-project",
      data,
      position: posById.get(id) ?? { x: 0, y: 0 },
    });
  }
  const edges: Edge[] = edgeList.map((e, i) => ({
    id: `e${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    type: "default",
    animated: false,
    style: { stroke: "var(--ti-ink-700, #6b7280)" },
    data: { kind: "depends_on" },
  }));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface ProjectFm {
  status: ProjectStatus;
  dependencies: string[];
}

/**
 * Parse `status:` (scalar) and `dependencies:` (block list or inline).
 * Same micro-parser approach as the lineage builder — no YAML dep.
 */
export function parseProjectFm(body: string): ProjectFm {
  const out: ProjectFm = { status: "idle", dependencies: [] };
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const fm = m[1];
  const lines = fm.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const status = line.match(/^status\s*:\s*(.+?)\s*$/);
    if (status) {
      const v = status[1].replace(/^["']|["']$/g, "").toLowerCase();
      if (v === "active" || v === "blocked" || v === "done" || v === "idle") {
        out.status = v;
      }
      continue;
    }

    const inline = line.match(/^dependencies\s*:\s*\[(.*)\]\s*$/);
    if (inline) {
      out.dependencies = inline[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    if (/^dependencies\s*:\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j].match(/^\s+-\s+(.+?)\s*$/);
        if (!item) break;
        out.dependencies.push(item[1].replace(/^["']|["']$/g, ""));
        j++;
      }
      i = j - 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tauri body reader
// ---------------------------------------------------------------------------

async function readProjectBodies(
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
          /* missing */
        }
      }),
    );
  } catch {
    /* plugin-fs unavailable */
  }
  return map;
}

// ---------------------------------------------------------------------------
// Project node
// ---------------------------------------------------------------------------

function ProjectNode({ data }: NodeProps<ProjectNodeData>) {
  const { border, dot } = statusStyle(data.status);
  return (
    <div
      data-testid={`topology-node-project-${data.slug}`}
      className="min-w-[160px] rounded-sm bg-stone-100 px-3 py-2 text-[12px] shadow-sm dark:bg-stone-800"
      style={{ borderLeft: `4px solid ${border}` }}
      title={`${data.label} · ${data.status}`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <FolderKanban
          size={12}
          className="text-stone-600 dark:text-stone-300"
          aria-hidden
        />
        <span className="truncate font-medium text-stone-800 dark:text-stone-100">
          {data.label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dot }}
          aria-hidden
        />
        <span className="font-mono text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {data.status}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function statusStyle(status: ProjectStatus): { border: string; dot: string } {
  switch (status) {
    case "active":
      return {
        border: "var(--ti-success, #2D8F4E)",
        dot: "var(--ti-success, #2D8F4E)",
      };
    case "blocked":
      return {
        border: "var(--ti-danger, #B5341E)",
        dot: "var(--ti-danger, #B5341E)",
      };
    case "done":
      return { border: "#9ca3af", dot: "#9ca3af" };
    case "idle":
    default:
      return {
        border: "var(--ti-warn, #C8841A)",
        dot: "var(--ti-warn, #C8841A)",
      };
  }
}

function prettyProjectLabel(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim().slice(0, 40) || slug;
}

export default ProjectTopology;
