// === wave 23 ===
/**
 * Wave 23 — Basic flat sortable list of all atoms for the /memory route.
 *
 * Sister view to MemoryTree (Wave 21) and MemoryGraphView (Wave 23). The
 * tree is hierarchical; the list is flat + sortable so a power user
 * looking for "all decisions touched by alex this week" can scan in one
 * dimension.
 *
 * Defensive: empty list → friendly empty state. No remote fetch — we
 * hydrate from the same `memory_graph_data` shape the graph view uses
 * (one row per atom with author/vendor/kind/timestamp pre-parsed) so the
 * two surfaces stay in lockstep.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";

import { memoryGraphData, type AtomGraphNode } from "@/lib/tauri";
import { vendorColor } from "@/lib/vendor-colors";
import { cn } from "@/lib/utils";

interface Props {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  vendorFilter?: string | null;
  kindFilter?: string | null;
}

type SortKey = "title" | "kind" | "author" | "vendor" | "date";
type SortDir = "asc" | "desc";

export function MemoryListView({
  selectedPath,
  onSelect,
  vendorFilter,
  kindFilter,
}: Props) {
  const { t } = useTranslation();
  const [atoms, setAtoms] = useState<AtomGraphNode[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancel = false;
    void memoryGraphData({
      vendor: vendorFilter ?? undefined,
      kind: kindFilter ?? undefined,
    }).then((d) => {
      if (cancel) return;
      setAtoms(d.nodes);
    });
    return () => {
      cancel = true;
    };
  }, [vendorFilter, kindFilter]);

  const sorted = useMemo(() => {
    if (!atoms) return [];
    const copy = [...atoms];
    copy.sort((a, b) => {
      const av = pluck(a, sortKey);
      const bv = pluck(b, sortKey);
      const cmp = av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [atoms, sortKey, sortDir]);

  if (atoms === null) {
    return (
      <div
        data-testid="memory-list-loading"
        className="flex h-full items-center justify-center"
      >
        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Loading…
        </p>
      </div>
    );
  }

  if (atoms.length === 0) {
    return (
      <div
        data-testid="memory-list-empty"
        className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <FileText size={28} className="text-stone-300 dark:text-stone-700" />
        <p className="text-sm text-stone-700 dark:text-stone-200">
          {t("memory.graph.emptyTitle", { defaultValue: "No atoms yet." })}
        </p>
      </div>
    );
  }

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "asc");
    }
  };

  return (
    <div
      data-testid="memory-list-view"
      className="flex h-full flex-col overflow-auto bg-stone-50 dark:bg-stone-950"
    >
      <table className="w-full font-mono text-[11px]">
        <thead className="sticky top-0 z-10 border-b border-stone-200 bg-white text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
          <tr>
            {(
              [
                ["title", "Title"],
                ["kind", "Kind"],
                ["author", "Author"],
                ["vendor", "Vendor"],
                ["date", "Date"],
              ] as [SortKey, string][]
            ).map(([k, label]) => (
              <th
                key={k}
                onClick={() => onHeaderClick(k)}
                data-testid={`memory-list-header-${k}`}
                className="cursor-pointer px-3 py-2 text-left font-medium uppercase tracking-wide hover:text-stone-700 dark:hover:text-stone-200"
              >
                {label}
                {sortKey === k && (
                  <span className="ml-1 text-[9px]">
                    {sortDir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const vc = a.vendor ? vendorColor(a.vendor) : null;
            const dotHex =
              vc && vc.hex.startsWith("linear-gradient")
                ? "#A855F7"
                : vc?.hex ?? "#78716C";
            const isActive = selectedPath === a.id;
            return (
              <tr
                key={a.id}
                onClick={() => onSelect(a.id)}
                data-testid={`memory-list-row-${a.id}`}
                aria-selected={isActive}
                className={cn(
                  "cursor-pointer border-b border-stone-100 hover:bg-stone-100 dark:border-stone-800 dark:hover:bg-stone-900",
                  isActive &&
                    "bg-[var(--ti-orange-50)] dark:bg-stone-800",
                )}
              >
                <td className="px-3 py-1.5 text-stone-800 dark:text-stone-100">
                  <span className="truncate">{a.label}</span>
                </td>
                <td className="px-3 py-1.5 text-stone-500 dark:text-stone-400">
                  {a.kind}
                </td>
                <td className="px-3 py-1.5 text-stone-500 dark:text-stone-400">
                  {a.author ?? "—"}
                </td>
                <td className="px-3 py-1.5 text-stone-500 dark:text-stone-400">
                  {a.vendor ? (
                    <span className="inline-flex items-center gap-1">
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: dotHex }}
                      />
                      {vc?.label ?? a.vendor}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-1.5 text-stone-500 dark:text-stone-400">
                  {a.timestamp ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function pluck(n: AtomGraphNode, key: SortKey): string {
  switch (key) {
    case "title":
      return n.label;
    case "kind":
      return n.kind;
    case "author":
      return n.author ?? "";
    case "vendor":
      return n.vendor ?? "";
    case "date":
      return n.timestamp ?? "";
  }
}
// === end wave 23 ===
