// === wave 21 ===
/**
 * Wave 21 — Obsidian-style /memory file tree.
 *
 * Hierarchical recursive tree. Folders expand on click; files emit
 * `onSelect(path)` so the right pane can render the preview. Vendor color
 * dot next to thread leaves (when `vendor` can be inferred from the path
 * — e.g. `personal/<user>/threads/<vendor>/...`). Selected file row gets
 * the orange highlight.
 *
 * Performance:
 *   - Folders render lazily (their children only mount when expanded), so
 *     a 1000+ file vault doesn't pay full DOM cost on first paint.
 *   - The Rust-side `memory_tree` command caps at 5000 nodes; this
 *     component renders whatever it gets without further filtering.
 *   - Title-match filter is applied via the `filter` prop and short-
 *     circuits via `nodeMatchesFilter` on each branch, so the fast
 *     feedback path doesn't hit the IPC again.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { vendorColor, ALL_VENDOR_IDS, type VendorId } from "@/lib/vendor-colors";
import type { MemoryTreeNode } from "@/lib/tauri";

interface Props {
  nodes: MemoryTreeNode[];
  /** Currently-selected file path (from the URL or local state). */
  selectedPath: string | null;
  /** Fired when the user clicks a file row. */
  onSelect: (path: string) => void;
  /** Optional title-match substring filter (case-insensitive). When non-empty,
   *  branches without any matching descendant are hidden. */
  filter?: string;
  /** Optional map: vendor id → bool. When supplied, file rows whose inferred
   *  vendor is NOT in the set are hidden. Empty map = no filter. */
  vendorFilter?: Record<string, boolean>;
}

export function MemoryTree({
  nodes,
  selectedPath,
  onSelect,
  filter,
  vendorFilter,
}: Props) {
  const trimmed = (filter ?? "").trim().toLowerCase();
  const visibleNodes = useMemo(
    () => nodes.filter((n) => nodeMatchesFilter(n, trimmed, vendorFilter)),
    [nodes, trimmed, vendorFilter],
  );

  if (visibleNodes.length === 0) {
    return (
      <div
        data-testid="memory-tree-empty"
        className="px-3 py-2 font-mono text-[11px] italic text-stone-400 dark:text-stone-500"
      >
        {trimmed ? "no matches" : "(empty)"}
      </div>
    );
  }

  return (
    <div
      data-testid="memory-tree"
      className="font-mono text-[11px]"
      role="tree"
      aria-label="Memory file tree"
    >
      {visibleNodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          filter={trimmed}
          vendorFilter={vendorFilter}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  filter,
  vendorFilter,
}: {
  node: MemoryTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  filter: string;
  vendorFilter?: Record<string, boolean>;
}) {
  // Top-level dirs + ancestors of any selected child stay open by default.
  const isAncestorOfSelected = useMemo(
    () => Boolean(selectedPath && selectedPath.startsWith(`${node.path}/`)),
    [selectedPath, node.path],
  );
  const [open, setOpen] = useState(depth === 0 || isAncestorOfSelected || filter.length > 0);

  const padLeft = 8 + depth * 12;

  if (node.kind === "dir") {
    const visibleChildren = (node.children ?? []).filter((c) =>
      nodeMatchesFilter(c, filter, vendorFilter),
    );
    return (
      <div data-testid={`memory-tree-dir-${node.path}`} role="treeitem">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900"
          style={{ paddingLeft: padLeft }}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={11} className="shrink-0 text-stone-400" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-stone-400" />
          )}
          <Folder size={11} className="shrink-0 text-stone-400" />
          <span className="truncate">{node.name}</span>
          {visibleChildren.length > 0 && (
            <span className="ml-auto pr-1 text-[9px] text-stone-400 dark:text-stone-500">
              {visibleChildren.length}
            </span>
          )}
        </button>
        {open && visibleChildren.length === 0 && (
          <p
            className="px-2 py-1 italic text-stone-300 dark:text-stone-600"
            style={{ paddingLeft: padLeft + 24 }}
          >
            (empty)
          </p>
        )}
        {open &&
          visibleChildren.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              filter={filter}
              vendorFilter={vendorFilter}
            />
          ))}
      </div>
    );
  }

  const isActive = selectedPath === node.path;
  const inferredVendor = inferVendorFromPath(node.path);
  const vc = inferredVendor ? vendorColor(inferredVendor) : null;
  const dotHex =
    vc && vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc?.hex;
  const displayName = stripMdExt(node.name);
  return (
    <button
      type="button"
      data-testid={`memory-tree-file-${node.path}`}
      onClick={() => onSelect(node.path)}
      role="treeitem"
      aria-selected={isActive}
      className={cn(
        "flex w-full items-center gap-1 rounded px-2 py-1 text-left",
        isActive
          ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
      )}
      style={{ paddingLeft: padLeft + 12 }}
      title={node.path}
    >
      <FileText size={11} className="shrink-0 text-stone-400" />
      <span className="truncate">{displayName}</span>
      {/* === v1.13.9 round-9 === —
          R9 deceptive-success audit: surface the Wave 13 demo-seed
          flag inline so a fresh user can tell `team/decisions/2026-04-22-
          tier2-pcb-supplier.md` (bundled sample) apart from their own
          team's decisions. The pill sits before the vendor dot so both
          can render together without overlap. Backend `sample` field is
          optional (older mocks omit it) — render only when explicitly
          true. */}
      {node.sample === true && (
        <span
          data-testid={`memory-tree-sample-pill-${node.path}`}
          title="Bundled sample data — clear it from Settings → Advanced."
          className="ml-auto rounded border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-50,#FFF5EC)] px-1 py-0 font-mono text-[8px] uppercase leading-tight tracking-wider text-[var(--ti-orange-700,#A04400)] dark:border-stone-600 dark:bg-stone-900 dark:text-[var(--ti-orange-500,#CC5500)]"
        >
          sample
        </span>
      )}
      {/* === end v1.13.9 round-9 === */}
      {dotHex && (
        <span
          aria-hidden
          data-testid={`memory-tree-vendor-dot-${node.path}`}
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            // === v1.13.9 round-9 === — when the sample pill is rendered
            // it claims `ml-auto`; the vendor dot just needs `ml-1.5` to
            // sit next to it. When no pill, fall back to the original
            // `ml-auto` so the dot still pushes to the right edge.
            node.sample === true ? "ml-1.5" : "ml-auto",
            // === end v1.13.9 round-9 ===
          )}
          style={{ background: dotHex }}
        />
      )}
    </button>
  );
}

/**
 * Infer a vendor id from a file's relative path. Looks for:
 *   - `personal/<user>/threads/<vendor>/...`
 *   - any path segment that exactly matches a known vendor id.
 *
 * Returns null when nothing matches.
 */
export function inferVendorFromPath(path: string): VendorId | null {
  const parts = path.split("/").filter(Boolean);
  // Direct: personal/<user>/threads/<vendor>/...
  const threadsIdx = parts.indexOf("threads");
  if (threadsIdx !== -1 && parts.length > threadsIdx + 1) {
    const candidate = parts[threadsIdx + 1].toLowerCase();
    const hit = ALL_VENDOR_IDS.find((v) => v.toLowerCase() === candidate);
    if (hit) return hit;
  }
  // Fallback: any segment that matches a known vendor.
  for (const seg of parts) {
    const lc = seg.toLowerCase();
    const hit = ALL_VENDOR_IDS.find((v) => v.toLowerCase() === lc);
    if (hit) return hit;
  }
  return null;
}

function stripMdExt(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, "");
}

/**
 * Recursively check if a node (or any of its descendants) matches the
 * given filter constraints. Used to hide branches that have no matching
 * descendants when a filter is active.
 */
function nodeMatchesFilter(
  node: MemoryTreeNode,
  filter: string,
  vendorFilter?: Record<string, boolean>,
): boolean {
  const titleMatches = filter.length === 0 || node.name.toLowerCase().includes(filter);
  const vendorOk = (() => {
    if (!vendorFilter) return true;
    const enabled = Object.entries(vendorFilter).filter(([, on]) => on).map(([k]) => k);
    if (enabled.length === 0) return true;
    if (node.kind === "file") {
      const v = inferVendorFromPath(node.path);
      // Files without inferred vendor pass through (decisions, meetings, etc.).
      return v === null || enabled.includes(v);
    }
    return true;
  })();
  if (node.kind === "file") {
    return titleMatches && vendorOk;
  }
  // Directories: match if name matches OR any descendant matches.
  if (titleMatches && (node.children ?? []).length === 0) return true;
  for (const child of node.children ?? []) {
    if (nodeMatchesFilter(child, filter, vendorFilter)) return true;
  }
  return titleMatches;
}
// === end wave 21 ===
