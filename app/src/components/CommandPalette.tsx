import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, Lock, Search, Sun, FileText } from "lucide-react";
import { signOut } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { searchMemory, type MemorySearchHit } from "@/lib/memory";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onSelect: () => void;
}

/**
 * Cmd+K / Ctrl+K palette. v1.5.4 repositioning:
 * - Primary mode = search memory. Type a query, get matching files.
 * - Empty query shows the bottom-shortcut row (Settings, Theme, Sign out).
 *
 * v1.5: search is a local substring match over markdown bodies (returns []
 * until source connectors land in v1.6+). v1.6 adds a real fulltext + vector
 * index over the memory dir.
 */
export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const cycleTheme = useStore((s) => s.ui.cycleTheme);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [active, setActive] = useState(0);

  const shortcuts: ShortcutItem[] = useMemo(
    () => [
      {
        id: "settings",
        label: "Settings",
        hint: "Open",
        icon: Settings,
        onSelect: () => {
          navigate("/settings");
          onClose();
        },
      },
      {
        id: "theme",
        label: "Cycle theme",
        hint: "system → light → dark",
        icon: Sun,
        onSelect: () => {
          cycleTheme();
          onClose();
        },
      },
      {
        id: "signout",
        label: "Sign out",
        hint: "Lock local memory",
        icon: Lock,
        onSelect: async () => {
          await signOut();
          navigate("/auth", { replace: true });
          onClose();
        },
      },
    ],
    [navigate, onClose, cycleTheme],
  );

  // Run search whenever the query changes.
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    void searchMemory(memoryRoot, query).then((rows) => {
      if (!cancelled) setHits(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [memoryRoot, query]);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const showHits = query.trim().length > 0;
  const items = showHits
    ? hits.map((h, i) => ({
        id: `hit:${i}`,
        label: h.path,
        hint: h.snippet,
        icon: FileText,
        onSelect: () => {
          navigate(`/memory/${h.path}`);
          onClose();
        },
      }))
    : shortcuts;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) it.onSelect();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-stone-200 bg-stone-50 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <Search size={16} className="text-stone-500 dark:text-stone-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search memory…"
            className="flex-1 bg-transparent text-sm text-stone-900 placeholder-stone-500 focus:outline-none dark:text-stone-100 dark:placeholder-stone-400"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 sm:inline dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            Esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-auto py-1">
          {showHits && items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
              <p>No matches.</p>
              <p className="mt-2 text-[11px] italic">
                Memory search reads the markdown files in your memory dir. v1.5 ships an
                empty index — once a Source writes files (Discord meetings, Linear threads,
                etc.), they show up here.
              </p>
            </div>
          ) : (
            items.map((it, idx) => {
              const Icon = it.icon;
              const isActive = idx === active;
              return (
                <button
                  key={it.id}
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={it.onSelect}
                  className={
                    "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-fast " +
                    (isActive
                      ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                      : "text-stone-900 hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-stone-800")
                  }
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="flex-1 truncate font-mono text-[12px]">{it.label}</span>
                  {it.hint && (
                    <span className="truncate text-[11px] text-stone-500 dark:text-stone-400">
                      {it.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="ti-no-select flex items-center justify-between border-t border-stone-200 bg-stone-100 px-4 py-2 text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
            <kbd className="font-mono">Enter</kbd> open
          </span>
          <span>{showHits ? "memory" : "shortcuts"}</span>
        </div>
      </div>
    </div>
  );
}
