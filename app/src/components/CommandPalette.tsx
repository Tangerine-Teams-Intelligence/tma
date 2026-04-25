import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, Lock, Search } from "lucide-react";
import { TOOLS, type ToolDef } from "@/lib/tools";
import { signOut } from "@/lib/auth";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Cmd+K / Ctrl+K palette. Lists the 10 tools + Settings + Sign out.
 * Filters by typed query, navigates on Enter.
 */
export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Build the static command list once.
  const allItems: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = TOOLS.map((tool: ToolDef) => ({
      id: `tool:${tool.id}`,
      label: tool.title,
      hint: tool.comingIn ? `Coming ${tool.comingIn}` : "Open",
      icon: tool.icon,
      onSelect: () => {
        navigate(tool.path);
        onClose();
      },
    }));
    items.push({
      id: "settings",
      label: "Settings",
      hint: "Open",
      icon: Settings,
      onSelect: () => {
        navigate("/settings");
        onClose();
      },
    });
    items.push({
      id: "signout",
      label: "Sign out",
      hint: "Lock local data",
      icon: Lock,
      onSelect: async () => {
        await signOut();
        navigate("/auth", { replace: true });
        onClose();
      },
    });
    return items;
  }, [navigate, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => it.label.toLowerCase().includes(q));
  }, [allItems, query]);

  // Reset state on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Defer focus to next tick so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep active index in bounds when filter shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered, active]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[active];
      if (it) it.onSelect();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--ti-border-faint)] px-4 py-3">
          <Search size={16} className="text-[var(--ti-ink-500)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search tools, settings…"
            className="flex-1 bg-transparent text-sm text-[var(--ti-ink-900)] placeholder-[var(--ti-ink-500)] focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-200)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--ti-ink-500)] sm:inline">
            Esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[var(--ti-ink-500)]">
              No matches.
            </p>
          ) : (
            filtered.map((it, idx) => {
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
                      ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                      : "text-[var(--ti-ink-900)] hover:bg-[var(--ti-paper-100)]")
                  }
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && (
                    <span className="text-[11px] text-[var(--ti-ink-500)]">{it.hint}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="ti-no-select flex items-center justify-between border-t border-[var(--ti-border-faint)] bg-[var(--ti-paper-100)] px-4 py-2 text-[10px] text-[var(--ti-ink-500)]">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
            <kbd className="font-mono">Enter</kbd> open
          </span>
          <span>Tangerine AI Teams</span>
        </div>
      </div>
    </div>
  );
}
