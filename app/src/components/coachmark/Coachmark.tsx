// === wave 22 ===
/**
 * Wave 22 — Coachmark.
 *
 * A floating tooltip anchored to a target element. Renders only when the
 * `CoachmarkProvider`'s `activeStep` matches the supplied `step` AND the
 * persisted dismiss memory hasn't already retired it.
 *
 * Targeting:
 *   - `targetSelector` is a CSS selector used with `document.querySelector`.
 *      Tests + the FirstRunTour pass a stable `data-testid` selector; ad-hoc
 *      callers can pass any selector. The lookup runs on mount + on every
 *      window resize / scroll so the tooltip tracks layout shifts.
 *   - If the target is missing the coachmark renders null and auto-dismisses
 *      the active step (`reason: "outside"`) so the parent tour advances.
 *      This is the documented graceful-skip behavior — without it the tour
 *      could stall forever waiting on an element that never mounts.
 *
 * Rendering:
 *   - The tooltip is portalled into `document.body` so a clipped overflow
 *      ancestor (sidebar, dashboard widget) can't clip it.
 *   - A subtle glow ring is portalled into the same layer, sized to the
 *      target's bounding rect so the user sees what's being highlighted.
 *   - Esc dismisses (`reason: "esc"`); a click outside the tooltip + ring
 *      forwards `onNext` (so a click anywhere advances the tour, like
 *      Notion / Linear).
 *
 * Layout fallback: if `placement` is provided we pin to that side; if the
 * computed coords would push the tooltip off-screen we fall back to bottom
 * with a generous safe-zone gutter. We don't try to mimic floating-ui — a
 * simple "best of 4 sides" is enough for a 6-step tour and avoids a new
 * dependency (per the build prompt's no-npm-deps constraint).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { useCoachmark } from "./CoachmarkProvider";

export type CoachmarkPlacement = "top" | "right" | "bottom" | "left";

export interface CoachmarkProps {
  /** Stable id — must match the value passed to `showStep(...)`. */
  step: string;
  /** CSS selector for the target element. Use a `data-testid` for stability. */
  targetSelector: string;
  title: string;
  body: ReactNode;
  /** Optional progress label, e.g. "1 of 6". Hidden when undefined. */
  stepLabel?: string;
  onNext?: () => void;
  onSkip?: () => void;
  /** When true, the primary CTA reads "Got it" instead of "Next" — used for
   *  the final step of a tour. */
  isFinal?: boolean;
  placement?: CoachmarkPlacement;
  /** Optional override for the dismiss memory id. Defaults to `step`. */
  dismissId?: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const TOOLTIP_WIDTH = 320;
const TOOLTIP_GAP = 12;
const SAFE_GUTTER = 16;

export function Coachmark({
  step,
  targetSelector,
  title,
  body,
  stepLabel,
  onNext,
  onSkip,
  isFinal,
  placement = "bottom",
  dismissId,
}: CoachmarkProps) {
  const { t } = useTranslation();
  const { activeStep, dismiss, isDismissed, markDismissed } = useCoachmark();
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);

  const id = dismissId ?? step;
  const isActive = activeStep === step;

  // Resolve target rect on mount + on every layout-affecting event.
  // useLayoutEffect so the first paint already has the correct position.
  useLayoutEffect(() => {
    if (!isActive) return;
    if (typeof document === "undefined") return;
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(targetSelector);
      if (!el) {
        setMissing(true);
        setRect(null);
        return;
      }
      setMissing(false);
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [isActive, targetSelector]);

  // Graceful skip — when target is missing, dismiss with reason "outside"
  // so the tour advances. Defer to a microtask so we don't dismiss during
  // a render cycle.
  useEffect(() => {
    if (!isActive) return;
    if (!missing) return;
    const handle = window.setTimeout(() => {
      markDismissed(id);
      dismiss("outside");
      onNext?.();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [isActive, missing, id, dismiss, markDismissed, onNext]);

  // Esc → skip.
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        markDismissed(id);
        dismiss("esc");
        onSkip?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, id, dismiss, markDismissed, onSkip]);

  const handleNext = useCallback(() => {
    markDismissed(id);
    dismiss("complete");
    onNext?.();
  }, [id, dismiss, markDismissed, onNext]);

  const handleSkip = useCallback(() => {
    markDismissed(id);
    dismiss("skip");
    onSkip?.();
  }, [id, dismiss, markDismissed, onSkip]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // Click on the backdrop itself (not the tooltip / ring) → advance.
      if (e.target === e.currentTarget) {
        handleNext();
      }
    },
    [handleNext],
  );

  if (!isActive) return null;
  if (isDismissed(id)) return null;
  if (typeof document === "undefined") return null;
  if (missing || !rect) return null;

  const ringStyle: React.CSSProperties = {
    position: "fixed",
    top: rect.top - 6,
    left: rect.left - 6,
    width: rect.width + 12,
    height: rect.height + 12,
    borderRadius: 10,
    pointerEvents: "none",
    boxShadow:
      "0 0 0 4px rgba(204,85,0,0.35), 0 0 0 9999px rgba(0,0,0,0.18)",
    transition: "all 180ms ease-out",
    zIndex: 80,
  };

  const tooltipPos = placeTooltip(rect, placement);
  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    top: tooltipPos.top,
    left: tooltipPos.left,
    width: TOOLTIP_WIDTH,
    zIndex: 81,
  };

  return createPortal(
    <div
      data-testid="coachmark-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[79]"
    >
      <div data-testid={`coachmark-ring-${step}`} style={ringStyle} />
      <div
        data-testid={`coachmark-${step}`}
        role="dialog"
        aria-labelledby={`coachmark-${step}-title`}
        style={tooltipStyle}
        onClick={(e) => e.stopPropagation()}
        className="rounded-lg border border-stone-200 bg-white p-4 shadow-xl dark:border-stone-700 dark:bg-stone-900"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {stepLabel && (
              <p
                data-testid={`coachmark-${step}-step-label`}
                className="font-mono text-[10px] uppercase tracking-wider text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]"
              >
                {stepLabel}
              </p>
            )}
            <h3
              id={`coachmark-${step}-title`}
              className="mt-1 font-display text-[15px] font-semibold leading-tight text-stone-900 dark:text-stone-100"
            >
              {title}
            </h3>
          </div>
          <button
            type="button"
            data-testid={`coachmark-${step}-skip`}
            aria-label={t("coachmark.skip")}
            onClick={handleSkip}
            className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          >
            <X size={14} />
          </button>
        </div>
        <div className="mt-2 text-[13px] leading-relaxed text-stone-700 dark:text-stone-300">
          {body}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid={`coachmark-${step}-skip-link`}
            onClick={handleSkip}
            className="font-mono text-[11px] text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline dark:text-stone-400 dark:hover:text-stone-200"
          >
            {t("coachmark.skip")}
          </button>
          <button
            type="button"
            data-testid={`coachmark-${step}-next`}
            onClick={handleNext}
            className="rounded-md bg-[var(--ti-orange-500)] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[var(--ti-orange-600)]"
          >
            {isFinal ? t("coachmark.done") : t("coachmark.next")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Compute tooltip position given target rect + preferred placement.
 *  Falls back to "bottom" inside the safe gutter when the chosen side
 *  would overflow the viewport. */
function placeTooltip(
  rect: Rect,
  placement: CoachmarkPlacement,
): { top: number; left: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const ESTIMATED_HEIGHT = 200;
  let top = rect.top + rect.height + TOOLTIP_GAP;
  let left = rect.left;
  if (placement === "top") {
    top = rect.top - ESTIMATED_HEIGHT - TOOLTIP_GAP;
    left = rect.left;
  } else if (placement === "right") {
    top = rect.top;
    left = rect.left + rect.width + TOOLTIP_GAP;
  } else if (placement === "left") {
    top = rect.top;
    left = rect.left - TOOLTIP_WIDTH - TOOLTIP_GAP;
  }
  // Clamp into viewport with safe gutter.
  if (left + TOOLTIP_WIDTH > vw - SAFE_GUTTER) {
    left = vw - TOOLTIP_WIDTH - SAFE_GUTTER;
  }
  if (left < SAFE_GUTTER) left = SAFE_GUTTER;
  if (top + ESTIMATED_HEIGHT > vh - SAFE_GUTTER) {
    top = Math.max(SAFE_GUTTER, vh - ESTIMATED_HEIGHT - SAFE_GUTTER);
  }
  if (top < SAFE_GUTTER) top = SAFE_GUTTER;
  return { top, left };
}
// === end wave 22 ===
