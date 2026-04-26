import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { ActivityFeed } from "@/components/ActivityFeed";
import { WhatsNewBanner } from "@/components/WhatsNewBanner";
import { useStore } from "@/lib/store";
import { markUserOpened } from "@/lib/views";

/**
 * Always-visible shell.
 *
 * Three vertical bands:
 *   • left   — Sidebar (240px)            : memory tree + sources/sinks/views
 *   • center — main content (flex-1)      : route Outlet
 *   • right  — ActivityFeed (300px, lg+)  : reverse-chrono atom rail
 *
 * The Cmd+K palette is mounted globally so it works from any route. The
 * yellow "what's new since you looked" banner is mounted at the very top
 * of the center band — it's hidden until cursor diff produces unseen
 * atoms older than 1 hour.
 */
export function AppShell() {
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.ui.dismissToast);
  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const togglePalette = useStore((s) => s.ui.togglePalette);
  const setPalette = useStore((s) => s.ui.setPalette);
  const localOnly = useStore((s) => s.ui.localOnly);
  const currentUser = useStore((s) => s.ui.currentUser);

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

  // Mark the user "opened" the app on every focus. Drives Stage 2
  // personalization (open-time learning) — Stage 1 just keeps cursor's
  // last_opened_at fresh so the WhatsNewBanner triggers correctly. The
  // initial mark happens on mount so the first session counts.
  useEffect(() => {
    let cancel = false;
    const tick = () => {
      if (cancel) return;
      void markUserOpened(currentUser);
    };
    tick();
    const onFocus = () => tick();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, [currentUser]);

  return (
    <div className="flex h-full w-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <WhatsNewBanner />
        {localOnly && (
          <div className="ti-no-select flex h-7 items-center justify-center border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[11px] font-medium text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]">
            Local memory only — sign in to sync your memory dir across machines.
          </div>
        )}
        <main className="flex-1 overflow-auto bg-stone-50 dark:bg-stone-950">
          <Outlet />
        </main>
      </div>

      <ActivityFeed />

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
