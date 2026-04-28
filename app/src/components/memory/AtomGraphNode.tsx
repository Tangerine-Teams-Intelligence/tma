// === wave 23 ===
/**
 * Wave 23 — Custom reactflow node renderer for the visual atom graph view.
 *
 * Visual decisions:
 *   - Vendor color tint background (8% opacity) so a wall of atoms reads as
 *     a vendor-colored map at a glance — mirrors the Wave 9 ribbon /
 *     sidebar dot system.
 *   - Solid vendor color dot on the left so the color survives even when
 *     the tint is faint.
 *   - Atom title (truncated to ~28 chars) as the primary label.
 *   - Selected → orange ring + brought to front via `z-index`.
 *   - Hover (CSS) shows a subtle shadow for affordance.
 *   - Node is dim when `data.dimmed` is true (search filter applied).
 *
 * Stays under 80 lines so we can audit it at a glance — the reactflow
 * rendering loop calls this on every pan / zoom, so the markup is
 * intentionally small.
 */

import { Handle, Position, type NodeProps } from "reactflow";
import { vendorColor } from "@/lib/vendor-colors";

export interface AtomGraphNodeData {
  label: string;
  vendor: string | null;
  author: string | null;
  kind: string;
  /** Optional path for the testid + title. */
  path: string;
  /** Optional project slug shown as a small sublabel. */
  project?: string | null;
  /** When true, render at reduced opacity (search filter dims non-matches). */
  dimmed?: boolean;
}

export function AtomGraphNode({ data, selected }: NodeProps<AtomGraphNodeData>) {
  const vc = data.vendor ? vendorColor(data.vendor) : null;
  const dotHex =
    vc && vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc?.hex ?? "#78716C";
  const tint = vc?.bgTint ?? "rgba(120, 113, 108, 0.08)";

  // Title truncation — keep nodes compact so the layout doesn't fight us
  // on dense graphs. Tooltip carries the full title for the curious.
  const display =
    data.label.length > 28 ? data.label.slice(0, 27) + "…" : data.label;

  return (
    <div
      data-testid={`atom-graph-node-${data.path}`}
      data-vendor={data.vendor ?? "unknown"}
      title={`${data.label} · ${data.kind}${data.author ? ` · ${data.author}` : ""}`}
      className={[
        "relative flex min-w-[120px] max-w-[200px] items-center gap-2",
        "rounded-md border px-2 py-1.5 text-[11px] shadow-sm transition-shadow",
        selected
          ? "border-[var(--ti-orange-500,#CC5500)] ring-2 ring-[var(--ti-orange-500,#CC5500)]/40 z-10"
          : "border-stone-300 hover:shadow dark:border-stone-700",
        data.dimmed ? "opacity-30" : "opacity-100",
      ].join(" ")}
      style={{ background: tint }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <span
        aria-hidden
        data-testid={`atom-graph-node-dot-${data.path}`}
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: dotHex }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-stone-800 dark:text-stone-100">
          {display}
        </p>
        {data.project && (
          <p className="truncate font-mono text-[9px] text-stone-500 dark:text-stone-400">
            {data.project}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}
// === end wave 23 ===
