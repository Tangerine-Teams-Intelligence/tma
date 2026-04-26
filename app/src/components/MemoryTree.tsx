import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FileText, Plus } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { MemoryNode } from "@/lib/memory";

interface Props {
  tree: MemoryNode[];
  /** When true, render a "+ new file" affordance at the bottom. */
  showNewFile?: boolean;
  onNewFile?: () => void;
}

/**
 * Recursive memory file tree. Linear / Vercel aesthetic — mono font, tight
 * rows, no shadows. Folders expand on click; files navigate to /memory/<path>.
 */
export function MemoryTree({ tree, showNewFile, onNewFile }: Props) {
  return (
    <div className="font-mono text-[11px]">
      {tree.length === 0 ? (
        <p className="px-2 py-1 italic text-stone-400 dark:text-stone-500">
          (empty)
        </p>
      ) : (
        tree.map((node) => <Node key={node.path} node={node} depth={0} />)
      )}
      {showNewFile && (
        <button
          type="button"
          onClick={onNewFile}
          className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-900 dark:hover:text-stone-200"
        >
          <Plus size={11} className="shrink-0" />
          <span>new file</span>
        </button>
      )}
    </div>
  );
}

function Node({ node, depth }: { node: MemoryNode; depth: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(depth === 0);

  const padLeft = 8 + depth * 12;

  if (node.kind === "dir") {
    const children = node.children ?? [];
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900"
          style={{ paddingLeft: padLeft }}
        >
          {open ? (
            <ChevronDown size={11} className="shrink-0 text-stone-400" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-stone-400" />
          )}
          <Folder size={11} className="shrink-0 text-stone-400" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <div>
            {children.length === 0 ? (
              <p
                className="px-2 py-1 italic text-stone-300 dark:text-stone-600"
                style={{ paddingLeft: padLeft + 24 }}
              >
                (empty)
              </p>
            ) : (
              children.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)
            )}
          </div>
        )}
      </div>
    );
  }

  const targetUrl = `/memory/${node.path}`;
  const isActive = location.pathname === targetUrl;
  return (
    <button
      type="button"
      onClick={() => navigate(targetUrl)}
      className={cn(
        "flex w-full items-center gap-1 rounded px-2 py-1 text-left",
        isActive
          ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
      )}
      style={{ paddingLeft: padLeft + 12 }}
    >
      <FileText size={11} className="shrink-0 text-stone-400" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
