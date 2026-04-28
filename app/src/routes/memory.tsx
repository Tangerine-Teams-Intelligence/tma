// === wave 4-D i18n ===
// === wave 21 === — Obsidian-style file-browser layout. Left pane is the
// file tree of `~/.tangerine-memory/`; right pane shows the selected
// atom's preview with frontmatter chips, body, and backlinks. Replaces
// the v1.6-era 3-pane shape (sidebar + center coverage + rail).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { memoryTree, type MemoryTreeNode, type MemoryTreeResult } from "@/lib/tauri";
import { MemoryTree } from "@/components/memory/MemoryTree";
import { MemoryPreview } from "@/components/memory/MemoryPreview";
import {
  MemoryFilterPills,
  type DateRange,
} from "@/components/memory/MemoryFilterPills";
import type { VendorId } from "@/lib/vendor-colors";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
import { logEvent } from "@/lib/telemetry";

/**
 * Wave 21 layout:
 *
 *   ┌───────────────────────────────────────────────────┐
 *   │ Memory · 87 atoms across 12 threads        [+]   │
 *   ├──────────────┬────────────────────────────────────┤
 *   │ Tree         │  Preview                            │
 *   │ ▼ team       │  (frontmatter chips + body +        │
 *   │   ▼ decisions│   backlinks)                        │
 *   │ ▼ personal   │                                     │
 *   │ Filter pills │                                     │
 *   └──────────────┴────────────────────────────────────┘
 *
 * The route handles both /memory and /memory/<*> via a single component
 * (path comes from useParams("*")).
 */
export default function MemoryRoute() {
  const { t } = useTranslation();
  const params = useParams();
  const navigate = useNavigate();
  const relPath = params["*"] ?? "";
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);

  const [treeResult, setTreeResult] = useState<MemoryTreeResult | null>(null);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState<Record<string, boolean>>({});
  const [dateRange, setDateRange] = useState<DateRange>("30d");

  // Onboarding redirect (preserved from v1.6).
  useEffect(() => {
    if (memoryConfigMode === undefined) {
      navigate("/onboarding-team", { replace: true });
    }
  }, [memoryConfigMode, navigate]);

  // Load the tree on mount + refresh on focus + on MEMORY_REFRESHED_EVENT.
  const refreshTree = useCallback(async () => {
    const result = await memoryTree({ depth: undefined });
    setTreeResult(result);
  }, []);

  useEffect(() => {
    void refreshTree();
    const onFocus = () => void refreshTree();
    const onRefreshed = () => void refreshTree();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
      }
    };
  }, [refreshTree, samplesSeeded, memoryRoot]);

  // Telemetry on atom open (preserved).
  useEffect(() => {
    if (!relPath) return;
    void logEvent("open_atom", { atom_path: relPath });
  }, [relPath]);

  const onSelect = useCallback(
    (path: string) => {
      navigate(`/memory/${path}`);
    },
    [navigate],
  );

  const onNewDecision = useCallback(() => {
    // Stub for now — the real "create decision" flow lands separately.
    // For wave 21 we just route to the existing onboarding flow as a hint.
    navigate("/canvas");
  }, [navigate]);

  const onVendorToggle = useCallback((vendor: VendorId) => {
    setVendorFilter((prev) => ({ ...prev, [vendor]: !prev[vendor] }));
  }, []);

  const onVendorReset = useCallback(() => {
    setVendorFilter({});
  }, []);

  const { atomCount, threadCount } = useMemo(
    () => deriveCounts(treeResult?.nodes ?? []),
    [treeResult],
  );

  return (
    <div className="flex h-full flex-col bg-stone-50 dark:bg-stone-950">
      <header
        data-testid="memory-header"
        className="ti-no-select flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-6 dark:border-stone-800"
      >
        <div className="flex items-baseline gap-2">
          <h1 className="font-display text-base tracking-tight text-stone-900 dark:text-stone-100">
            Memory
          </h1>
          <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
            · {atomCount} atoms across {threadCount} threads
            {treeResult?.truncated ? " · truncated" : ""}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onNewDecision}
          data-testid="memory-new-decision"
          aria-label={t("memory.newDecision", { defaultValue: "New decision" })}
        >
          <Plus size={12} />
          New decision
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside
          data-testid="memory-left-pane"
          className="flex w-[280px] shrink-0 flex-col border-r border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950"
        >
          <div className="flex-1 overflow-auto px-1 py-2">
            <MemoryTree
              nodes={treeResult?.nodes ?? []}
              selectedPath={relPath || null}
              onSelect={onSelect}
              filter={search}
              vendorFilter={vendorFilter}
            />
          </div>
          <div className="shrink-0 border-t border-stone-200 dark:border-stone-800">
            <MemoryFilterPills
              vendorFilter={vendorFilter}
              onVendorToggle={onVendorToggle}
              onVendorReset={onVendorReset}
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
              search={search}
              onSearchChange={setSearch}
            />
          </div>
        </aside>

        <section
          data-testid="memory-right-pane"
          className="flex-1 overflow-auto bg-stone-50 dark:bg-stone-950"
          tabIndex={-1}
        >
          <MemoryPreview relPath={relPath || null} />
        </section>
      </div>
    </div>
  );
}

/**
 * Walk the tree and count atom files + distinct threads. A "thread" is any
 * directory that contains at least one .md file.
 */
function deriveCounts(nodes: MemoryTreeNode[]): {
  atomCount: number;
  threadCount: number;
} {
  let atomCount = 0;
  const threads = new Set<string>();
  function walk(ns: MemoryTreeNode[], parent: string): void {
    let dirHasFile = false;
    for (const n of ns) {
      if (n.kind === "file") {
        atomCount += 1;
        dirHasFile = true;
      } else {
        walk(n.children ?? [], n.path);
      }
    }
    if (dirHasFile && parent) {
      threads.add(parent);
    }
  }
  walk(nodes, "");
  return { atomCount, threadCount: threads.size };
}
