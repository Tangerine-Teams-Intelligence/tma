import { useEffect, useMemo, useState, useCallback } from "react";
// Hoisted nodeTypes lives at the bottom of this file (after the
// Node component declarations) — see NODE_TYPES.
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
import { Bot, FileText, Users, Diamond as DiamondIcon } from "lucide-react";

import { listAtoms, type AtomEntry } from "@/lib/atoms";
import { useStore } from "@/lib/store";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  layoutGraph,
  rankForKind,
  basenameSlug,
} from "./graphLayout";

/**
 * v2.0-alpha.2 — Workflow Graph (home dashboard pillar #1).
 *
 * Per V2_0_SPEC §2.1 — replace the chronological /today list with a
 * graph-first home screen. Nodes: people / projects / decisions / agents
 * (telemetry-driven). Edges: information flow (mention, edit, assign,
 * derived_from). VISUAL_DESIGN_SPEC §4 locks the rendering language —
 * person rounded-rect, project blue square, decision orange diamond,
 * agent green circle.
 *
 * Data flow:
 *   1. `listAtoms` → flat list of {rel_path, kind, scope, name}
 *   2. derive node set: one per person / project / decision; one per
 *      personal-vault directory entry that looks like an agent capture
 *      (cursor / claude-code / devin / replit / shortcuts).
 *   3. derive edges: people mentioned in a decision filename get a
 *      "mention" edge; agents touching a project filename get an "edit"
 *      edge. Stage 1 is rule-based on the path string — Stage 2 will
 *      replace with frontmatter `source_refs:` reading once the v2.0-beta.1
 *      lineage builder lands.
 *   4. dagre-shaped layout from `graphLayout.ts`.
 *
 * Interactions:
 *   - Click node → navigate to canonical detail surface
 *     (`/people/<alias>`, `/projects/<slug>`, `/memory/<path>`).
 *   - Pan + zoom out of the box from reactflow.
 *
 * Performance budget per V2_0_SPEC §2.1: < 500ms p95 for ≤300 nodes /
 * 1000 edges. We measure before optimising — the rule-based builder is
 * O(N) over atoms.
 */
export function WorkflowGraph() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.ui.currentUser);
  const [atoms, setAtoms] = useState<AtomEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void listAtoms({ current_user: currentUser, include_personal: true })
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

  const { nodes, edges } = useMemo(() => buildGraph(atoms ?? []), [atoms]);

  const onNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      const data = node.data as WorkflowNodeData | undefined;
      if (!data) return;
      const target = atomDetailRoute(data);
      if (target) navigate(target);
    },
    [navigate],
  );

  if (atoms === null) {
    return (
      <div
        data-testid="workflow-graph-loading"
        aria-busy="true"
        aria-label="Workflow graph loading"
        className="relative h-[480px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      >
        {/* Faux-graph skeleton — three node-clusters + edge bars so the
            loading shell roughly matches the resolved layout density. */}
        <div className="absolute left-12 top-16 flex flex-col gap-3">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-32 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
        <div className="absolute left-1/2 top-12 -translate-x-1/2 flex flex-col gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-9 w-9 rotate-45" />
          <Skeleton className="h-9 w-9 rounded-full" />
        </div>
        <div className="absolute right-12 top-16 flex flex-col gap-3">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
            Loading workflow…
          </p>
        </div>
      </div>
    );
  }

  if (atoms.length === 0) {
    return <WorkflowGraphEmpty error={error} />;
  }

  return (
    <div
      data-testid="workflow-graph"
      className="h-[560px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      role="region"
      aria-label="Workflow graph"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
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

function WorkflowGraphEmpty({ error }: { error: string | null }) {
  return (
    <div
      data-testid="workflow-graph-empty"
      className="flex h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50/50 px-6 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <p className="text-[13px] font-medium text-stone-700 dark:text-stone-200">
        Your workflow graph is empty
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
        Connect a source to see your team's workflow. Atoms from Discord,
        Slack, GitHub, Linear and the rest will fan out into people,
        projects, decisions and agents here.
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

export type WorkflowNodeKind = "person" | "project" | "decision" | "agent";

export interface WorkflowNodeData {
  kind: WorkflowNodeKind;
  label: string;
  /** rel_path on disk for atom-backed nodes (project / decision / agent) or
   *  the alias for a person node. */
  ref: string;
  /** "team" | "personal" — passed through from list_atoms; persons are
   *  considered team-scoped. */
  scope?: string;
  /** Optional secondary label rendered under the primary one. */
  sub?: string;
}

interface BuiltGraph {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Turn the flat atom list into reactflow nodes + edges.
 *
 * Exported so the unit test can exercise the builder without spinning up
 * the full reactflow renderer.
 */
export function buildGraph(atoms: AtomEntry[]): BuiltGraph {
  const builder = new GraphBuilder();
  for (const a of atoms) {
    builder.absorb(a);
  }
  return builder.materialize();
}

class GraphBuilder {
  private nodes = new Map<string, WorkflowNodeData>();
  private edges: { source: string; target: string; kind: string }[] = [];

  absorb(a: AtomEntry): void {
    switch (a.kind) {
      case "people": {
        const alias = basenameSlug(a.name);
        this.upsertNode(`person:${alias}`, {
          kind: "person",
          label: alias,
          ref: alias,
          scope: a.scope,
        });
        break;
      }
      case "projects": {
        const slug = basenameSlug(a.name);
        const id = `project:${slug}`;
        this.upsertNode(id, {
          kind: "project",
          label: slug,
          ref: a.rel_path,
          scope: a.scope,
        });
        break;
      }
      case "decisions": {
        const slug = basenameSlug(a.name);
        const id = `decision:${slug}`;
        this.upsertNode(id, {
          kind: "decision",
          label: prettyDecisionLabel(slug),
          ref: a.rel_path,
          scope: a.scope,
          sub: slug,
        });
        // Mention edge: decision filename containing a known person alias
        // implies that person was mentioned. Real source_refs reading lands
        // in v2.0-beta.1 — this is the rule-based v2.0-alpha.2 placeholder.
        for (const personId of this.matchingPersonIds(slug)) {
          this.edges.push({ source: personId, target: id, kind: "mention" });
        }
        break;
      }
      case "agents":
      default: {
        // Personal-vault agent captures live under
        // `personal/<user>/cursor/<...>.md` etc. Atoms with kind "agents"
        // and personal-vault paths whose 3rd segment is a known agent
        // tool name (cursor / claude-code / devin / replit / shortcuts)
        // collapse to one node per tool.
        const segs = a.rel_path.split("/");
        if (a.scope === "personal" && segs.length >= 4) {
          const tool = segs[2];
          if (AGENT_TOOLS.has(tool)) {
            const id = `agent:${tool}`;
            this.upsertNode(id, {
              kind: "agent",
              label: tool,
              ref: a.rel_path,
              scope: a.scope,
              sub: segs[1],
            });
          }
        }
        break;
      }
    }
  }

  /**
   * Person ids that appear as a substring of the decision slug. Used so
   * `2026-04-pricing-daizhe.md` connects to `person:daizhe`. Cheap O(P*1)
   * loop — P is small.
   */
  private matchingPersonIds(slug: string): string[] {
    const lower = slug.toLowerCase();
    const out: string[] = [];
    for (const [id, data] of this.nodes) {
      if (data.kind !== "person") continue;
      if (lower.includes(data.label.toLowerCase())) {
        out.push(id);
      }
    }
    return out;
  }

  private upsertNode(id: string, data: WorkflowNodeData): void {
    if (!this.nodes.has(id)) this.nodes.set(id, data);
  }

  materialize(): BuiltGraph {
    const inNodes: { id: string; rank?: number }[] = [];
    for (const [id, data] of this.nodes) {
      inNodes.push({ id, rank: rankForKind(data.kind) });
    }
    const inEdges = this.edges.map((e) => ({ source: e.source, target: e.target }));
    const positions = layoutGraph(inNodes, inEdges);
    const posById = new Map(positions.map((p) => [p.id, p.position]));

    const nodes: Node[] = [];
    for (const [id, data] of this.nodes) {
      nodes.push({
        id,
        type: data.kind,
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

const AGENT_TOOLS = new Set([
  "cursor",
  "claude-code",
  "claude_code",
  "devin",
  "replit",
  "shortcuts",
]);

function prettyDecisionLabel(slug: string): string {
  // Strip leading date prefix like "2026-04-" so the diamond label reads
  // as the topic, not the date.
  const withoutDate = slug.replace(/^\d{4}-\d{2}(?:-\d{2})?-?/, "");
  const cleaned = withoutDate.replace(/[-_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 40) : slug;
}

function edgeStyle(kind: string): React.CSSProperties {
  switch (kind) {
    case "mention":
      return { strokeDasharray: "4 4", stroke: "var(--ti-ink-700, #6b7280)" };
    case "conflict":
      return { stroke: "var(--ti-danger, #B5341E)", strokeWidth: 2 };
    default:
      return { stroke: "var(--ti-ink-700, #6b7280)" };
  }
}

function atomDetailRoute(data: WorkflowNodeData): string | null {
  switch (data.kind) {
    case "person":
      return `/people/${encodeURIComponent(data.ref)}`;
    case "project":
      return `/projects/${encodeURIComponent(basenameSlug(data.ref))}`;
    case "decision":
    case "agent":
      return `/memory/${encodeURI(data.ref)}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Custom node components — each maps to one VISUAL_DESIGN_SPEC §4 shape.
// ---------------------------------------------------------------------------

function PersonNode({ data }: NodeProps<WorkflowNodeData>) {
  return (
    <div
      data-testid={`workflow-node-person-${data.ref}`}
      className="flex min-w-[120px] items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-[12px] shadow-sm dark:border-stone-600 dark:bg-stone-900"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Users size={14} className="shrink-0 text-stone-500" aria-hidden />
      <span className="truncate font-medium text-stone-800 dark:text-stone-100">
        @{data.label}
      </span>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function ProjectNode({ data }: NodeProps<WorkflowNodeData>) {
  return (
    <div
      data-testid={`workflow-node-project-${basenameSlug(data.ref)}`}
      className="min-w-[140px] rounded-sm border-l-4 border-blue-500 bg-stone-100 px-3 py-2 text-[12px] shadow-sm dark:bg-stone-800"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <FileText size={12} className="text-blue-600 dark:text-blue-400" aria-hidden />
        <span className="truncate font-medium text-stone-800 dark:text-stone-100">
          {data.label}
        </span>
      </div>
      {data.sub && (
        <p className="mt-0.5 truncate font-mono text-[10px] text-stone-500 dark:text-stone-400">
          {data.sub}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function DecisionNode({ data }: NodeProps<WorkflowNodeData>) {
  // Diamond is a rotated square with the label rotated back. We frame in
  // a wrapper so reactflow positions the bounding box, not the rotated
  // visual.
  return (
    <div
      data-testid={`workflow-node-decision-${basenameSlug(data.ref)}`}
      className="relative h-[80px] w-[150px]"
      title={data.sub ?? data.label}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: "rotate(45deg)" }}
      >
        <div className="h-[68px] w-[68px] bg-[var(--ti-orange-500,#CC5500)] shadow-sm" />
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

function AgentNode({ data }: NodeProps<WorkflowNodeData>) {
  return (
    <div
      data-testid={`workflow-node-agent-${data.label}`}
      className="flex h-[80px] w-[80px] flex-col items-center justify-center rounded-full bg-[var(--ti-success,#2D8F4E)] text-white shadow-sm"
      title={data.sub ? `${data.label} · ${data.sub}` : data.label}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Bot size={20} aria-hidden />
      <span className="mt-1 px-1 text-center text-[10px] font-semibold leading-tight">
        {data.label}
      </span>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

/**
 * Hoisted nodeTypes object. Defining this outside the component body
 * stops React Flow from emitting the "[React Flow]: It looks like you've
 * created a new nodeTypes…" warning on every render — the prop identity
 * is now stable across renders by reference, not just per-component
 * `useMemo` (which still creates a fresh object on remount).
 */
const NODE_TYPES = {
  person: PersonNode,
  project: ProjectNode,
  decision: DecisionNode,
  agent: AgentNode,
} as const;

export default WorkflowGraph;
