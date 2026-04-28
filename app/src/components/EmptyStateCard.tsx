// === v1.15.0 Wave 2.2 ===
/**
 * EmptyStateCard — first-run "Capture your first X" empty state.
 *
 * Wave 2.2 fixes the demo-to-real cliff: a fresh user finishes the
 * 5-step tour over /people /threads /co-thinker (all populated by demo
 * seed) then exits demo mode and lands on blank pages with no idea what
 * to do. This card replaces every blank page with a centered, branded
 * "Capture your first X" CTA that routes back into the setup flow, plus
 * a secondary "See the demo →" affordance that re-enables `demoMode`
 * for users who need a refresher.
 *
 * Detection contract (in callers, not here):
 *   - data is empty array AND firstAtomCapturedAt === null
 *       → render <EmptyStateCard /> (this component)
 *   - data is empty array AND firstAtomCapturedAt !== null
 *       → render a lighter "No items yet" message (caller's choice)
 *   - fetch errored
 *       → render the existing error UI (do NOT mount this component)
 *
 * Telemetry: emits `empty_state_shown` on mount and
 * `empty_state_cta_clicked` on primary CTA click. Both events are
 * fire-and-forget; the surface is included as a payload field so the
 * suggestion engine can later spot "user keeps landing on empty
 * /people → maybe their PII filter is too aggressive" patterns.
 *
 * Coordination notes (Wave 2.2 parallel agents):
 *   - W1.4 owns telemetry.ts — the two new event names
 *     (`empty_state_shown`, `empty_state_cta_clicked`) need to be added
 *     to its TelemetryEventName union. Until then we cast at the call
 *     site so the build stays green.
 *   - W1.4 also owns store.ts and the new `firstAtomCapturedAt: string
 *     | null` field. We only read it, never write.
 *   - W1.1 / W1.2 own SetupWizard / AIToolDetectionGrid; we link to
 *     /setup/connect via react-router but do not import those modules.
 */

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

export interface EmptyStateCardProps {
  /** Lucide (or any) icon node, rendered centered above the title. */
  icon: ReactNode;
  /** Primary heading — short, declarative ("Teammates appear here..."). */
  title: string;
  /** 1-2 sentence body explaining why empty + what to do. */
  description: string;
  /** Primary CTA button label ("Invite a teammate →"). */
  ctaLabel: string;
  /**
   * Primary CTA action. If a string, treated as a react-router path and
   * navigated to. If a function, called directly so the caller can do
   * custom routing / store mutation / both.
   */
  ctaAction: string | (() => void);
  /**
   * Stable identifier for telemetry. Becomes the `surface` payload field
   * on both `empty_state_shown` + `empty_state_cta_clicked`. Examples:
   * "people", "threads", "co-thinker", "today", "this-week",
   * "memory-tree", "people-detail", "threads-detail".
   */
  telemetrySurface: string;
  /**
   * Optional badge / chip rendered between the description and the CTA.
   * Used by /co-thinker for the "0/5 atoms captured" progress hint.
   */
  badge?: ReactNode;
  /** Optional data-testid override. Defaults to `empty-state-card`. */
  testId?: string;
}

/**
 * Centered first-run empty state card. See file header for the broader
 * detection contract and telemetry shape.
 */
export function EmptyStateCard({
  icon,
  title,
  description,
  ctaLabel,
  ctaAction,
  telemetrySurface,
  badge,
  testId,
}: EmptyStateCardProps) {
  const navigate = useNavigate();
  const setDemoMode = useStore((s) => s.ui.setDemoMode);

  // Fire-and-forget telemetry on mount. Wave 4 wire-up: events
  // `empty_state_shown` and `empty_state_cta_clicked` are now in the
  // `TelemetryEventName` union (Wave 2.2 section), so the cast that
  // existed during parallel agent dev has been removed.
  useEffect(() => {
    void logEvent("empty_state_shown", { surface: telemetrySurface });
  }, [telemetrySurface]);

  function handlePrimary() {
    void logEvent("empty_state_cta_clicked", { surface: telemetrySurface });
    if (typeof ctaAction === "string") {
      navigate(ctaAction);
    } else {
      ctaAction();
    }
  }

  function handleSeeDemo() {
    // Re-enter demo mode so the user can refresh their mental model of
    // what a populated app looks like. The DemoModeBanner / FirstRunTour
    // will pick the flag back up on the next render cycle.
    setDemoMode(true);
  }

  return (
    <section
      data-testid={testId ?? "empty-state-card"}
      data-surface={telemetrySurface}
      className="mx-auto my-8 flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-8 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <div
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--ti-paper-200)] text-[var(--ti-ink-500)] dark:bg-stone-800 dark:text-stone-300"
      >
        {icon}
      </div>
      <h3 className="font-display text-lg tracking-tight text-[var(--ti-ink-900)] dark:text-stone-100">
        {title}
      </h3>
      <p className="text-[13px] leading-relaxed text-[var(--ti-ink-600)] dark:text-stone-400">
        {description}
      </p>
      {badge && (
        <div data-testid="empty-state-badge" className="mt-1">
          {badge}
        </div>
      )}
      <div className="mt-3 flex flex-col items-center gap-2">
        <Button
          size="sm"
          onClick={handlePrimary}
          data-testid="empty-state-cta"
        >
          {ctaLabel}
        </Button>
        <button
          type="button"
          onClick={handleSeeDemo}
          data-testid="empty-state-see-demo"
          className="font-mono text-[11px] text-stone-500 underline-offset-2 hover:text-[var(--ti-orange-700)] hover:underline dark:text-stone-400 dark:hover:text-[var(--ti-orange-500)]"
        >
          Need help? See the demo →
        </button>
      </div>
    </section>
  );
}

export default EmptyStateCard;
// === end v1.15.0 Wave 2.2 ===
