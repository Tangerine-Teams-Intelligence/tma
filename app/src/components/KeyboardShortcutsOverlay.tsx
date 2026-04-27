/**
 * Wave 5-β keyboard shortcuts overlay.
 *
 * Bound to `?` (Shift+/) globally. Shows a 2-column table of every
 * keyboard shortcut the app recognises. Mounted at AppShell so the
 * `?` key works from any route.
 *
 * Hidden by default — appears as a centred modal when triggered. Esc
 * dismisses it.
 *
 * Why this lives separately from HelpButton's per-page panel: the
 * help panel is route-scoped (Today's shortcuts ≠ Canvas's), but
 * power users want a single global cheatsheet they can hit from
 * anywhere without thinking about which route is active. Both
 * surfaces share `GLOBAL_SHORTCUTS`; this overlay extends with the
 * full app-wide cheatsheet.
 */

import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";

import { GLOBAL_SHORTCUTS, type HelpShortcut } from "@/help/help-registry";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Full cheatsheet. Builds on `GLOBAL_SHORTCUTS` and adds the route-
 * specific ones the user might encounter often. Keep this list under
 * 20 — beyond that the modal becomes a wall of text.
 */
const ALL_SHORTCUTS: { section: string; rows: HelpShortcut[] }[] = [
  {
    section: "Global",
    rows: GLOBAL_SHORTCUTS,
  },
  {
    section: "Navigation",
    rows: [
      { keys: "G then T", label: "Go to /today (typed in sequence)" },
      { keys: "G then M", label: "Go to /memory" },
      { keys: "G then C", label: "Go to /co-thinker" },
      { keys: "G then S", label: "Go to /settings" },
    ],
  },
  {
    section: "Co-thinker",
    rows: [
      { keys: "Cmd/Ctrl+E", label: "Toggle edit mode on the brain doc" },
      { keys: "Cmd/Ctrl+S", label: "Save brain edits" },
    ],
  },
  {
    section: "Canvas",
    rows: [
      { keys: "Double-click", label: "Drop a sticky at cursor" },
      { keys: "Drag", label: "Reposition sticky" },
    ],
  },
];

export function KeyboardShortcutsOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Flatten for the count display in the footer.
  const total = ALL_SHORTCUTS.reduce((n, sec) => n + sec.rows.length, 0);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      data-testid="shortcuts-overlay"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-stone-200 bg-stone-50 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-stone-500" />
            <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
              Keyboard shortcuts
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close shortcuts overlay"
            onClick={onClose}
            data-testid="shortcuts-close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          >
            <X size={14} />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-auto px-4 py-3">
          {ALL_SHORTCUTS.map((sec) => (
            <section key={sec.section} className="mb-4 last:mb-0">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                {sec.section}
              </h3>
              <table className="mt-2 w-full text-[12px]">
                <tbody>
                  {sec.rows.map((s, i) => (
                    <tr
                      key={i}
                      className="border-t border-stone-200 first:border-t-0 dark:border-stone-800"
                    >
                      <td className="w-[140px] py-1.5 pr-3">
                        <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
                          {s.keys}
                        </kbd>
                      </td>
                      <td className="py-1.5 text-stone-700 dark:text-stone-300">
                        {s.label}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>

        <footer className="ti-no-select flex items-center justify-between border-t border-stone-200 bg-stone-100 px-4 py-2 text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
          <span>{total} shortcuts · press ? anytime to reopen</span>
          <span>
            <kbd className="font-mono">Esc</kbd> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
