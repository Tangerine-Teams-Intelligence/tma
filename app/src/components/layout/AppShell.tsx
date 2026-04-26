import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { useStore } from "@/lib/store";

/**
 * Always-visible shell. Sidebar (240px) on the left, main pane scrolls. The
 * Cmd+K palette is mounted globally so it works from any route.
 */
export function AppShell() {
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.ui.dismissToast);
  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const togglePalette = useStore((s) => s.ui.togglePalette);
  const setPalette = useStore((s) => s.ui.setPalette);
  const localOnly = useStore((s) => s.ui.localOnly);

  // Cmd+K / Ctrl+K → toggle palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        togglePalette();
      }
      if (e.key === "Escape" && paletteOpen) {
        setPalette(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setPalette, paletteOpen]);

  return (
    <div className="flex h-full w-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {localOnly && (
          <div className="ti-no-select flex h-7 items-center justify-center border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[11px] font-medium text-[var(--ti-orange-700)] dark:bg-stone-900 dark:text-[var(--ti-orange-500)]">
            Local memory only — sign in to sync your memory dir across machines.
          </div>
        )}
        <main className="flex-1 overflow-auto bg-stone-50 dark:bg-stone-950">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPalette(false)} />

      {/* Toast layer */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              onClick={() => dismissToast(t.id)}
              className="pointer-events-auto max-w-sm cursor-pointer rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm shadow-md animate-fade-in dark:border-stone-800 dark:bg-stone-900"
            >
              <span
                className={
                  t.kind === "success"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : t.kind === "error"
                      ? "text-rose-700 dark:text-rose-400"
                      : "text-stone-700 dark:text-stone-300"
                }
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
