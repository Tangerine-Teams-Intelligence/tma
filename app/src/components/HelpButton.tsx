/**
 * Wave 5-β help button — floating `?` in the bottom-right of every
 * route. Click opens a popover panel with the route's help entry +
 * shortcut list + "report a bug" link.
 *
 * Mounted by AppShell so it follows the user across routes. The panel
 * reads `useLocation().pathname` on each open so the contents are
 * always for the current page.
 *
 * Closes on Esc, on backdrop click, or on the close `×`. Does NOT
 * trap focus — the panel is small and dismissable; users always have
 * a way out.
 *
 * The position is bottom-right so it doesn't collide with the
 * sidebar / activity-feed columns. Uses `position: fixed` so a long
 * route page doesn't push it off-screen.
 */

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { HelpCircle, X, ExternalLink } from "lucide-react";

import { helpFor, GLOBAL_SHORTCUTS } from "@/help/help-registry";
import { logEvent } from "@/lib/telemetry";
import { openExternal } from "@/lib/tauri";

const ISSUES_URL = "https://github.com/Tangerine-Intelligence/tangerine-teams-app/issues";

export function HelpButton() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Esc to close. Local listener so it doesn't fight with the global
  // shortcuts overlay (which also reacts to Esc).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function handleOpen() {
    void logEvent("help_open", { route: location.pathname });
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        aria-label="Help"
        onClick={handleOpen}
        data-testid="help-button"
        className="fixed bottom-4 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-500 shadow-md transition-colors hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-100"
      >
        <HelpCircle size={16} />
      </button>

      {open && <HelpPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const entry = helpFor(location.pathname);
  // Combine global shortcuts with route-specific ones. Global come
  // first so the user always sees Cmd+K / ? / Esc.
  const allShortcuts = [
    ...GLOBAL_SHORTCUTS,
    ...(entry.shortcuts ?? []),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:items-center sm:justify-center sm:bg-black/30 sm:backdrop-blur-sm"
      onClick={onClose}
      data-testid="help-panel"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-stone-200 bg-stone-50 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-stone-500">
              {location.pathname}
            </p>
            <h2 className="mt-0.5 font-display text-base text-stone-900 dark:text-stone-100">
              {entry.title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close help"
            onClick={onClose}
            data-testid="help-close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          >
            <X size={14} />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-auto px-4 py-3">
          <p className="text-[13px] leading-relaxed text-stone-700 dark:text-stone-300">
            {entry.body}
          </p>

          <div className="mt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
              Shortcuts
            </h3>
            <table className="mt-2 w-full text-[12px]">
              <tbody>
                {allShortcuts.map((s, i) => (
                  <tr
                    key={i}
                    className="border-t border-stone-200 first:border-t-0 dark:border-stone-800"
                  >
                    <td className="py-1 pr-3">
                      <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
                        {s.keys}
                      </kbd>
                    </td>
                    <td className="py-1 text-stone-700 dark:text-stone-300">
                      {s.label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-stone-200 bg-stone-100 px-4 py-2 text-[11px] dark:border-stone-800 dark:bg-stone-900">
          <span className="text-stone-500">Help · Wave 5-β</span>
          <button
            type="button"
            onClick={() => void openExternal(ISSUES_URL)}
            className="inline-flex items-center gap-1 text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
          >
            Report a bug
            <ExternalLink size={11} />
          </button>
        </footer>
      </div>
    </div>
  );
}
