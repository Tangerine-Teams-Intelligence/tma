/**
 * v1.16 Wave 5 — AtomBottomSheet.
 *
 * Mobile-only slide-up panel that replaces inline expand for atom detail
 * on viewports < 768px. Desktop keeps the existing inline expand path so
 * power users who triage 50 atoms in a session don't lose flow to a sheet
 * animation; mobile users (touch, one-hand, no hover) get a finger-
 * friendly drawer pinned to the bottom of the viewport.
 *
 * Behaviour:
 *   - Backdrop covers full viewport with bg-black/60 + click-outside close
 *   - Panel slides up from bottom, max-height 75vh, scrolls inside
 *   - Close affordances: tap outside, ESC, swipe down (touchstart →
 *     touchend Δy > 80px), the explicit X button at the top right
 *   - Renders the atom body in full (no truncation) plus a pure-typography
 *     header line: actor · source · clock · date
 *   - z-50 so it lives above the sticky FilterChips bar
 *
 * Keep simple: no reach for portals / framer-motion / react-aria. The
 * AppShell already z-stacks overlays at z-40 (backdrop) / z-50 (modal),
 * so this sheet plugs into the same stacking order without surprises.
 *
 * v1.19.2 Round 3 Fix 1 — chrome cleanup: removed the Avatar circle and
 * the colored vendor dot. The header is now pure typography:
 *   `daizhe · cursor · 14:32 · 2026-04-29`
 * Sans for the actor (medium weight); mono for the source / clock / date
 * triplet. Separator `·` rendered in stone-300. The close `×` (already
 * text-only) stays in the top-right.
 */

import { useEffect, useRef } from "react";
import type { TimelineEvent } from "@/lib/views";

export interface AtomBottomSheetProps {
  /** The atom to render. When null, the sheet is closed (returns null). */
  event: TimelineEvent | null;
  /** Caller is responsible for clearing `event` (or setting open=false). */
  onClose: () => void;
}

/** Swipe-down distance (px) that closes the sheet. */
const SWIPE_DOWN_CLOSE_PX = 80;

export function AtomBottomSheet({ event, onClose }: AtomBottomSheetProps) {
  const touchStartY = useRef<number | null>(null);
  // ESC key listener — mounts only while the sheet is open so we don't
  // intercept ESC for the rest of the app on every render.
  useEffect(() => {
    if (!event) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [event, onClose]);

  if (!event) return null;

  const body = event.body ?? event.kind ?? "(no body)";
  const headerActor = event.actor && event.actor.length > 0 ? event.actor : "?";
  const headerSource = event.source && event.source.length > 0 ? event.source : "?";
  const headerClock = formatHeaderClock(event.ts);
  const headerDate = formatHeaderDate(event.ts);

  function onTouchStart(e: React.TouchEvent) {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStartY.current;
    touchStartY.current = null;
    if (start === null) return;
    const end = e.changedTouches[0]?.clientY ?? start;
    if (end - start > SWIPE_DOWN_CLOSE_PX) onClose();
  }

  return (
    <div
      data-testid="atom-bottom-sheet"
      data-event-id={event.id}
      role="dialog"
      aria-modal="true"
      aria-label="Atom detail"
      className="fixed inset-0 z-50 flex flex-col justify-end"
    >
      <button
        type="button"
        aria-label="Close atom detail"
        data-testid="atom-bottom-sheet-backdrop"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <section
        data-testid="atom-bottom-sheet-panel"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="relative max-h-[75vh] w-full overflow-y-auto rounded-t-2xl border-t border-stone-200 bg-white px-4 pb-6 pt-3 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
      >
        {/* Drag handle — visual affordance for swipe-down close. Pure
            decoration; the close gesture is the real handler above.
            v1.19.2 Round 3 visual fix V7 — hide on desktop (≥md / 768px)
            since there's no swipe gesture there; mobile keeps the
            affordance. */}
        <div
          aria-hidden
          data-testid="atom-bottom-sheet-drag-handle"
          className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-300 dark:bg-stone-700 md:hidden"
        />
        <header className="flex items-start gap-3">
          <div
            data-testid="atom-bottom-sheet-header"
            className="min-w-0 flex-1"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                data-testid="atom-bottom-sheet-actor"
                className="font-sans text-[14px] font-medium text-stone-900 dark:text-stone-100"
              >
                {headerActor}
              </span>
              <span
                aria-hidden
                className="font-mono text-[11px] text-stone-300 dark:text-stone-700"
              >
                ·
              </span>
              <span
                data-testid="atom-bottom-sheet-source"
                className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
              >
                {headerSource}
              </span>
              <span
                aria-hidden
                className="font-mono text-[11px] text-stone-300 dark:text-stone-700"
              >
                ·
              </span>
              <time
                dateTime={event.ts}
                title={event.ts}
                data-testid="atom-bottom-sheet-clock"
                className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
              >
                {headerClock}
              </time>
              <span
                aria-hidden
                className="font-mono text-[11px] text-stone-300 dark:text-stone-700"
              >
                ·
              </span>
              <span
                data-testid="atom-bottom-sheet-date"
                className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
              >
                {headerDate}
              </span>
            </div>
          </div>
          <button
            type="button"
            data-testid="atom-bottom-sheet-close"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 rounded px-2 py-1 font-mono text-[14px] leading-none text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </header>
        <p
          data-testid="atom-bottom-sheet-body"
          className="mt-4 whitespace-pre-wrap text-[14px] leading-relaxed text-stone-800 dark:text-stone-200"
        >
          {body}
        </p>
        {event.concepts && event.concepts.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {event.concepts.slice(0, 8).map((c) => (
              <span
                key={c}
                className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
              >
                #{c}
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * v1.19.2 Round 3 Fix 1 — header clock formatter.
 *
 * Returns `HH:MM` from an ISO timestamp; returns `??:??` when the input
 * is null / unparseable. Mirrors the pattern used by feed.tsx so the
 * bottom-sheet header reads as "14:32" without seconds / TZ noise.
 */
function formatHeaderClock(iso: string | null | undefined): string {
  if (!iso) return "??:??";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  return d.toISOString().slice(11, 16);
}

/**
 * v1.19.2 Round 3 Fix 1 — header date formatter.
 *
 * Returns `YYYY-MM-DD` from an ISO timestamp. Falls back to `????-??-??`
 * when the input is null / unparseable, matching the clock helper's
 * honesty pattern.
 */
function formatHeaderDate(iso: string | null | undefined): string {
  if (!iso) return "????-??-??";
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "????-??-??";
  return d.toISOString().slice(0, 10);
}

/**
 * Detect mobile viewport via matchMedia. Tailwind's `md:` breakpoint is
 * 768px; we treat anything narrower as "mobile". Returns false during SSR
 * / when window is missing so server-rendered code never accidentally
 * dispatches the sheet.
 */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") {
    return typeof window.innerWidth === "number" && window.innerWidth < 768;
  }
  return window.matchMedia("(max-width: 767px)").matches;
}
