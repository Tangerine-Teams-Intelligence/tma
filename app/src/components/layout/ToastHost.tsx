/**
 * v1.20.0 — ToastHost.
 *
 * The audit found that `useStore.ui.toasts[]` was being WRITTEN to by ~12
 * call sites (Settings → Connect → Sync now / Git init / etc) but NEVER
 * RENDERED. Toasts went into a black hole. So the IDE-capture "wrote N,
 * skipped M" feedback that v1.18.2's R6 audit hardened was invisible to
 * the user — they clicked "Sync now" and saw nothing happen.
 *
 * Honesty rule (R6): if state changes, the user must see it. ToastHost
 * is the missing piece.
 *
 * Behavior:
 *   • Renders the bottom-right toast stack pinned `fixed`. Newest at top
 *     of the stack so the user sees the most-recent action first.
 *   • Errors are sticky (no auto-dismiss); info/success auto-dismiss
 *     after the per-toast `durationMs` (default 4000ms; the store sets
 *     `undefined` for errors).
 *   • Click anywhere on a toast → dismiss. Plus an explicit ✕ close on hover.
 *   • Empty stack → renders nothing (no aria-live noise on idle).
 *
 * Mounted from AppShell.tsx alongside Spotlight + ModalHost. Does not
 * conflict with BannerHost (top-of-route) — banners are persistent
 * suggestions; toasts are transient action confirmations.
 */

import { useEffect, useRef } from "react";

import { useStore } from "@/lib/store";

export function ToastHost() {
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.ui.dismissToast);
  // Track which toast ids have already had their auto-dismiss timer
  // scheduled so re-renders don't double-schedule (React 18 strict mode
  // would otherwise blow through error toasts).
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timers: number[] = [];
    for (const t of toasts) {
      if (scheduledRef.current.has(t.id)) continue;
      // Errors are sticky — `durationMs` is undefined for them per
      // store.ts.
      if (t.durationMs === undefined || t.kind === "error") {
        scheduledRef.current.add(t.id);
        continue;
      }
      const ms = t.durationMs;
      scheduledRef.current.add(t.id);
      const id = window.setTimeout(() => {
        dismissToast(t.id);
        scheduledRef.current.delete(t.id);
      }, ms);
      timers.push(id);
    }
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts, dismissToast]);

  // Garbage-collect scheduledRef when toasts are dismissed externally
  // (e.g. user clicks ✕). Without this, re-pushing a toast with the same
  // id (rare, but possible if a v1.9 suggestion enrichment recycles id)
  // would skip its timer. Small cost; safe correctness.
  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const id of [...scheduledRef.current]) {
      if (!live.has(id)) scheduledRef.current.delete(id);
    }
  }, [toasts]);

  if (toasts.length === 0) return null;

  // Newest first — store appends, so reverse for display.
  const stack = [...toasts].reverse();

  return (
    <div
      data-testid="toast-host"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 max-w-[90vw] flex-col gap-2"
    >
      {stack.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          data-toast-kind={t.kind}
          className={
            "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] shadow-lg backdrop-blur " +
            (t.kind === "error"
              ? "border-rose-300 bg-rose-50/95 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/80 dark:text-rose-100"
              : t.kind === "success"
                ? "border-emerald-200 bg-emerald-50/95 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/80 dark:text-emerald-100"
                : t.kind === "info"
                  ? "border-stone-200 bg-white/95 text-stone-800 dark:border-stone-700 dark:bg-stone-900/95 dark:text-stone-100"
                  : "border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50,#fff5e8)]/95 text-stone-900 dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900/95 dark:text-stone-100")
          }
        >
          <span className="min-w-0 flex-1 break-words font-mono">{t.text ?? t.msg}</span>
          <button
            type="button"
            data-testid="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(t.id)}
            className="-mr-1 shrink-0 rounded px-1 text-stone-400 hover:bg-stone-200/50 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastHost;
