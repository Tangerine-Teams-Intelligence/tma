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
import { Users } from "lucide-react";

import { listAtoms, type AtomEntry } from "@/lib/atoms";
import { useStore } from "@/lib/store";
import { basenameSlug } from "./graphLayout";

/**
 * v2.0-beta.1 — Social Graph (V2_0_SPEC §2.3).
 *
 * Nodes pulled from `team/people/`; edges weighted by how often two
 * aliases co-appear in the same atom body (and how recently). Force-
 * directed circle layout — direction isn't meaningful here, distance is.
 *
 * Edge weight per spec:
 *
 *     mention_count * decay(t) + context_overlap
 *     decay(t) = exp(-t / 7d)
 *
 * v2.0-beta.1 implements this with a small simplification — atom recency
 * is a single timestamp parsed from the filename leading date prefix
 * (`2026-04-25-roadmap.md` → 2026-04-25). Atoms without a date prefix
 * are treated as "now" so they don't get penalised on a fresh launch.
 *
 * Layout: a circle, sorted by total weighted degree so the most-connected
 * person sits at angle 0. Edges drawn with thickness proportional to
 * weight (clamped to 1–4px). reactflow's built-in physics is opt-in via
 * `simulationStrength` on each node — we intentionally use the static
 * circle layout to keep tests deterministic; the visual still reads as
 * "connected people cluster together" because we sort by degree.
 *
 * Pure builder (`buildSocialGraph`) is unit-testable; the live component
 * pulls atom bodies from Tauri fs in a `useEffect`.
 */
export function SocialGraph({
  windowDays = 30,
}: { windowDays?: number } = {}) {
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

  // Read every atom body — mention scanning works across all kinds, not
  // just decisions. Capped at 500 atoms via slice so we don't stall the
  // first paint on giant memory dirs; the graph stays useful with a 7d
  // working set even when the long tail is huge.
  useEffect(() => {
    if (atoms === null) return;
    let cancel = false;
    const subset = atoms.slice(0, 500);
    void readAtomBodies(memoryRoot, subset).then((map) => {
      if (cancel) return;
      setBodies(map);
    });
    return () => {
      cancel = true;
    };
  }, [atoms, memoryRoot]);

  const { nodes, edges } = useMemo(
    () => buildSocialGraph(atoms ?? [], bodies, { windowDays }),
    [atoms, bodies, windowDays],
  );

  const onNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      const data = node.data as SocialNodeData | undefined;
      if (!data) return;
      navigate(`/people/${encodeURIComponent(data.alias)}`);
    },
    [navigate],
  );

  const nodeTypes = useMemo(() => ({ "social-person": PersonNode }), []);

  if (atoms === null) {
    return (
      <div
        data-testid="social-graph-loading"
        className="flex h-[480px] w-full items-center justify-center rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      >
        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Loading social graph…
        </p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return <SocialEmpty error={error} />;
  }

  return (
    <div
      data-testid="social-graph"
      className="h-[640px] w-full overflow-hidden rounded-md border border-stone-200 bg-stone-50/50 dark:border-stone-800 dark:bg-stone-900/40"
      role="region"
      aria-label="Social graph"
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

function SocialEmpty({ error }: { error: string | null }) {
  return (
    <div
      data-testid="social-graph-empty"
      className="flex h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50/50 px-6 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <p className="text-[13px] font-medium text-stone-700 dark:text-stone-200">
        No people atoms yet
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
        The social graph reads `team/people/*.md` and scans every atom for
        @mentions. Add a teammate or connect Discord/Slack to populate this.
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

export interface SocialNodeData {
  alias: string;
  label: string;
  /** Total weighted degree — used for sizing. */
  weight: number;
}

interface BuiltSocialGraph {
  nodes: Node[];
  edges: Edge[];
  /** Raw aggregated edge weights — exposed so tests can assert without
   *  reaching into reactflow data. */
  rawEdges: { from: string; to: string; weight: number }[];
}

export interface BuildSocialOptions {
  windowDays?: number;
  /** "Now" override for tests. Defaults to Date.now(). */
  now?: Date;
}

/**
 * Pure builder. Returns reactflow-shaped nodes + edges, plus a `rawEdges`
 * list for tests that want to verify the weight math without rendering.
 */
export function buildSocialGraph(
  atoms: AtomEntry[],
  bodies: Map<string, string>,
  opts: BuildSocialOptions = {},
): BuiltSocialGraph {
  const windowDays = opts.windowDays ?? 30;
  const now = opts.now ?? new Date();

  // 1. Collect aliases from people atoms.
  const aliases = new Set<string>();
  for (const a of atoms) {
    if (a.kind !== "people") continue;
    aliases.add(basenameSlug(a.name).toLowerCase());
  }

  // 2. Walk every atom body (regardless of kind), count weighted
  //    co-occurrences between aliases.
  const weights = new Map<string, number>(); // "a|b" → weight (a < b lexically)
  const totalDegree = new Map<string, number>();
  for (const a of atoms) {
    const body = bodies.get(a.rel_path);
    if (!body) continue;
    const ts = atomTimestamp(a, now);
    const ageDays = (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > windowDays) continue;
    const decay = Math.exp(-ageDays / 7);

    const present = aliasesPresent(body, aliases);
    if (present.size < 2) continue;
    const list = Array.from(present).sort();
    // Each unordered pair gets a contribution = decay (mention_count is
    // implicit at 1 per atom containing the pair) + context_overlap = 1
    // (they touched the same atom). v2.0-spec collapses both into a
    // single weighted increment.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}|${list[j]}`;
        const inc = decay + 1;
        weights.set(key, (weights.get(key) ?? 0) + inc);
        totalDegree.set(list[i], (totalDegree.get(list[i]) ?? 0) + inc);
        totalDegree.set(list[j], (totalDegree.get(list[j]) ?? 0) + inc);
      }
    }
  }

  // 3. Sort aliases by degree desc so the densest node lands at angle 0.
  const sorted = Array.from(aliases).sort(
    (a, b) => (totalDegree.get(b) ?? 0) - (totalDegree.get(a) ?? 0),
  );

  // 4. Place nodes in a circle. Radius scales with count.
  const N = sorted.length;
  const radius = Math.max(160, 60 + 24 * N);
  const nodes: Node[] = sorted.map((alias, i) => {
    const theta = N === 0 ? 0 : (2 * Math.PI * i) / N;
    return {
      id: `person:${alias}`,
      type: "social-person",
      data: {
        alias,
        label: alias,
        weight: totalDegree.get(alias) ?? 0,
      } satisfies SocialNodeData,
      position: {
        x: Math.cos(theta) * radius,
        y: Math.sin(theta) * radius,
      },
    };
  });

  // 5. Edges with thickness ∝ weight.
  const maxW = Math.max(1, ...Array.from(weights.values()));
  const edges: Edge[] = [];
  const rawEdges: { from: string; to: string; weight: number }[] = [];
  let i = 0;
  for (const [key, w] of weights) {
    const [a, b] = key.split("|");
    const norm = w / maxW;
    const px = 1 + Math.round(norm * 3); // 1–4px
    edges.push({
      id: `e${i++}-${a}-${b}`,
      source: `person:${a}`,
      target: `person:${b}`,
      type: "default",
      animated: false,
      style: {
        stroke: "var(--ti-ink-700, #6b7280)",
        strokeWidth: px,
        opacity: 0.3 + 0.7 * norm,
      },
      data: { weight: w },
    });
    rawEdges.push({ from: a, to: b, weight: w });
  }

  return { nodes, edges, rawEdges };
}

/**
 * Find aliases that appear in the body. Matches `@alias` or the alias as
 * a whole word (so "daizhe approved …" counts even without @). Case-
 * insensitive.
 */
export function aliasesPresent(body: string, aliases: Set<string>): Set<string> {
  const out = new Set<string>();
  const lower = body.toLowerCase();
  for (const a of aliases) {
    // Cheap pre-filter: substring miss → skip the regex cost.
    if (!lower.includes(a)) continue;
    const re = new RegExp(`(?:^|[^a-z0-9_])@?${escapeRe(a)}(?:[^a-z0-9_]|$)`, "i");
    if (re.test(body)) out.add(a);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull a timestamp out of the atom path. Recognises `YYYY-MM-DD`
 * leading-date filenames (the convention every Stage-1 source uses).
 * Falls back to `now` so an undated atom doesn't get binned out by
 * the `windowDays` filter.
 */
export function atomTimestamp(a: AtomEntry, now: Date): Date {
  const m = a.name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return now;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? now : d;
}

// ---------------------------------------------------------------------------
// Tauri body reader
// ---------------------------------------------------------------------------

async function readAtomBodies(
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
// Person node — sized by weight per VISUAL_DESIGN_SPEC §4.
// ---------------------------------------------------------------------------

function PersonNode({ data }: NodeProps<SocialNodeData>) {
  // Scale the badge width with weight, clamped so the layout stays sane.
  const px = 110 + Math.min(60, Math.round((data.weight ?? 0) * 4));
  return (
    <div
      data-testid={`social-node-person-${data.alias}`}
      className="flex items-center gap-2 rounded-md border border-stone-300 bg-white py-2 text-[12px] shadow-sm dark:border-stone-600 dark:bg-stone-900"
      style={{ minWidth: px, paddingInline: 12 }}
      title={`@${data.label} · weight ${data.weight.toFixed(1)}`}
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

export default SocialGraph;
