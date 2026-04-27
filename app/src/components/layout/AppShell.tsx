import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { ActivityFeed } from "@/components/ActivityFeed";
import { WhatsNewBanner } from "@/components/WhatsNewBanner";
import { AmbientInputObserver } from "@/components/ambient/AmbientInputObserver";
// v1.9.0-beta.1 — banner + modal hosts. The bus pushes into bannerStack /
// modalQueue and these hosts read the top entry. The hosts MUST live
// inside the AppShell (not inside the Outlet) so they survive route
// changes — banners are explicitly cross-route.
import { BannerHost } from "@/components/suggestions/BannerHost";
import { ModalHost } from "@/components/suggestions/ModalHost";
import { useStore } from "@/lib/store";
import { markUserOpened } from "@/lib/views";
import { userFacingFoldersEmpty } from "@/lib/memory";
import { initMemoryWithSamples, resolveMemoryRoot } from "@/lib/tauri";
// v1.9.0-beta.1 P1-A — log every route transition so the suggestion engine
// (P1-B + v1.9.0-beta.2) can detect navigation patterns ("you bounced
// /memory ↔ /canvas 5×", "you haven't seen /today in 3 days"). Fire-and-
// forget; never blocks UI.
import { logEvent } from "@/lib/telemetry";

/** Custom DOM event name dispatched after a successful sample-seed so the
 *  sidebar tree + /today timeline can refresh in-place without a route nav. */
export const MEMORY_REFRESHED_EVENT = "tangerine:memory-refreshed";

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
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const setSamplesSeeded = useStore((s) => s.ui.setSamplesSeeded);
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);

  // First-launch + self-healing sample seed.
  //
  // Lives at the AppShell level (not in /memory) because v1.7 changed the
  // default landing surface from /memory to /today. Without this, a fresh
  // user lands on /today and never visits /memory until later — meanwhile the
  // Module A daemon writes `.tangerine/` and `timeline/` sidecars on its
  // first heartbeat, so by the time the user finally hits /memory the old
  // "is the memory dir empty?" check from Rust returns false and seeding
  // gets skipped forever.
  //
  // The fix is a smarter check: we only care whether the user-facing
  // markdown subfolders (meetings/, decisions/, etc.) have any content. If
  // they're all empty we (re)seed regardless of daemon sidecars or the
  // persisted samplesSeeded flag (the flag self-heals on reinstall).
  //
  // Gating:
  //   * memoryConfigMode != null    → past onboarding
  //   * userFacingFoldersEmpty(...) → no user content lives here
  // After a successful seed we dispatch MEMORY_REFRESHED_EVENT so the
  // sidebar tree + /today timeline rerun their reads immediately, with no
  // page reload needed.
  useEffect(() => {
    if (memoryConfigMode === undefined) return;
    let cancel = false;
    void (async () => {
      const info = await resolveMemoryRoot();
      if (cancel) return;
      if (info.path && info.path !== memoryRoot && !info.path.startsWith("~")) {
        setMemoryRoot(info.path);
      }
      const root = info.path && !info.path.startsWith("~") ? info.path : memoryRoot;
      const empty = await userFacingFoldersEmpty(root);
      if (cancel) return;
      if (!empty) {
        // User content already lives here — sync the persisted flag forward
        // so the tree-refresh deps in Sidebar / memory route stay accurate.
        if (!samplesSeeded) setSamplesSeeded(true);
        return;
      }
      // User-facing folders are empty. If the persisted flag is stale (true
      // from a prior install whose data was wiped), reset so callers know we
      // are re-seeding.
      if (samplesSeeded) setSamplesSeeded(false);
      const r = await initMemoryWithSamples();
      if (cancel) return;
      if (r.path && !r.path.startsWith("~")) {
        setMemoryRoot(r.path);
      }
      // Only commit the flag once seeding actually wrote files. After a
      // successful copy, fan a refresh event out so the sidebar tree + the
      // /today timeline re-read without forcing a route nav.
      if (r.seeded || r.copied > 0) {
        setSamplesSeeded(true);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [memoryConfigMode, memoryRoot, samplesSeeded, setMemoryRoot, setSamplesSeeded]);

  // v1.9.0-beta.1 — auto-dismiss timers for toasts that declared a
  // `durationMs`. Each timer is keyed by the toast id; we clean them up
  // when the toast leaves the array (user clicked, programmatic dismiss).
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const t of toasts) {
      if (t.durationMs && t.durationMs > 0) {
        const id = t.id;
        timers.push(
          setTimeout(() => dismissToast(id), t.durationMs),
        );
      }
    }
    return () => {
      for (const tm of timers) clearTimeout(tm);
    };
  }, [toasts, dismissToast]);

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

  // v1.9.0-beta.1 P1-A — log every route transition. We track `prev` in a
  // ref so the very first render emits `from: ""` (cold-start landing
  // event) and subsequent navigations emit a real `from`. fire-and-forget
  // via `void` so a Tauri stall never blocks the route change.
  const location = useLocation();
  const prevPathRef = useRef<string>("");
  useEffect(() => {
    const to = location.pathname;
    const from = prevPathRef.current;
    if (from === to) return;
    prevPathRef.current = to;
    void logEvent("navigate_route", { from, to });
  }, [location.pathname]);

  // v1.9.0-beta.1 P1-A — user-initiated toast dismiss. Wraps `dismissToast`
  // so the click + Esc paths log telemetry, while the auto-dismiss timer
  // above does NOT (auto-dismiss is a timeout, not a user action). The
  // suggestion engine uses dismiss_toast frequency to detect "user
  // ignored 5 suggestion-toasts in a row → quiet for 24h" patterns.
  const dismissToastWithTelemetry = (id: string) => {
    const t = toasts.find((x) => x.id === id);
    if (t) {
      void logEvent("dismiss_toast", {
        toast_id: id,
        kind: t.kind,
      });
    }
    dismissToast(id);
  };

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
    // v1.8 Phase 4 — the AmbientInputObserver wraps the whole shell so a
    // single delegated input listener sees every textarea / contenteditable
    // / palette input in the app. There is intentionally no chatbot tab;
    // every input is an AGI entry point.
    <AmbientInputObserver>
      <div className="flex h-full w-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <WhatsNewBanner />
          {localOnly && (
            <div className="ti-no-select flex h-7 items-center justify-center border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[11px] font-medium text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]">
              Local memory only — sign in to sync your memory dir across machines.
            </div>
          )}
          {/* v1.9.0-beta.1 — banner host sits below the system strips so the
              suggestion-tier banners feel like part of the route content. */}
          <BannerHost />
          <main className="flex-1 overflow-auto bg-stone-50 dark:bg-stone-950">
            <Outlet />
          </main>
        </div>

        <ActivityFeed />

        <CommandPalette open={paletteOpen} onClose={() => setPalette(false)} />

        {/* Toast layer.
            v1.9.0-beta.1: now also renders kind="suggestion" toasts with a
            🍊 prefix dot and an optional CTA. Suggestion toasts auto-dismiss
            after `durationMs` (default 4s); errors stick. */}
        {toasts.length > 0 && (
          <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
            {toasts.map((t) => {
              const isSuggestion = t.kind === "suggestion";
              return (
                <div
                  key={t.id}
                  role="status"
                  data-toast-id={t.id}
                  data-toast-kind={t.kind}
                  data-testid={isSuggestion ? "suggestion-toast" : "toast"}
                  className="pointer-events-auto max-w-sm rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm shadow-md animate-fade-in dark:border-stone-800 dark:bg-stone-900"
                >
                  <div className="flex items-start gap-2">
                    {isSuggestion && (
                      <span
                        aria-hidden
                        className="mt-0.5 inline-block flex-shrink-0 text-[14px]"
                        title="Tangerine"
                      >
                        🍊
                      </span>
                    )}
                    <span
                      onClick={() => dismissToastWithTelemetry(t.id)}
                      className={
                        "min-w-0 flex-1 cursor-pointer " +
                        (t.kind === "success"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : t.kind === "error"
                            ? "text-rose-700 dark:text-rose-400"
                            : "text-stone-700 dark:text-stone-300")
                      }
                    >
                      {t.msg}
                    </span>
                  </div>
                  {isSuggestion && t.ctaLabel && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        data-testid="suggestion-toast-cta"
                        onClick={() => {
                          try {
                            if (t.onAccept) t.onAccept();
                            else if (t.ctaHref && typeof window !== "undefined") {
                              window.location.href = t.ctaHref;
                            }
                          } finally {
                            dismissToast(t.id);
                          }
                        }}
                        className="rounded border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-100,#FFE4CD)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-200,#FFD0A8)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-700"
                      >
                        {t.ctaLabel}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* v1.9.0-beta.1 — modal host. Lives outside the flex column so the
            portal-rendered backdrop covers the full viewport. */}
        <ModalHost />
      </div>
    </AmbientInputObserver>
  );
}
