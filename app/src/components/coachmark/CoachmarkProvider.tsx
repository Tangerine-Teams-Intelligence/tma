// === wave 22 ===
/**
 * Wave 22 — CoachmarkProvider.
 *
 * Lightweight React context that any component can use to drive a guided
 * coachmark/tour overlay. The provider tracks at most one active step at
 * a time (coachmarks are intentionally sequential — never two glowing
 * targets at once) plus the set of dismissed step ids and the active
 * tour name (so a host can scope dismiss + telemetry).
 *
 * Public API (via `useCoachmark()`):
 *   - `activeStep`   — the id of the step currently showing, or null.
 *   - `activeTour`   — the tour name when in tour mode, or null.
 *   - `showStep(id, opts?)` — promote a step to the active slot. If `opts.tour`
 *      is supplied the tour name is recorded so dismiss telemetry attributes
 *      correctly. Idempotent — re-firing the same id is a no-op.
 *   - `dismiss(reason?)` — clear the active step. The reason ("complete" /
 *      "skip" / "esc" / "outside") is forwarded to telemetry. Defaults to
 *      "complete" so a clean Next-button click reads as a positive event.
 *   - `isDismissed(id)` — true when the persisted store says the user has
 *      already retired that step. The Coachmark component bails to null if
 *      true so re-mounting the same id is safe.
 *   - `markDismissed(id)` — push the id into the persisted dismiss set.
 *      Called by the Coachmark renderer after a Next click so a re-mount
 *      doesn't replay the same tooltip.
 *
 * Why a provider instead of plain props on `<Coachmark/>`?
 *   The first-run tour needs to walk through a fixed sequence; each
 *   Coachmark's "Next" must promote the next step without the parent
 *   threading callbacks down. Centralising the active-step state lets
 *   the FirstRunTour kick the sequence off and the Coachmarks themselves
 *   remain stateless render leaves.
 *
 * Failure mode: if a target element doesn't exist, the Coachmark renders
 * null AND auto-dismisses the active step so the tour advances. This is
 * the one risk we have to manage — a coachmark frozen on a missing target
 * would stall the whole tour.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

export type CoachmarkDismissReason = "complete" | "skip" | "esc" | "outside";

interface CoachmarkContextValue {
  activeStep: string | null;
  activeTour: string | null;
  showStep: (stepId: string, opts?: { tour?: string }) => void;
  dismiss: (reason?: CoachmarkDismissReason) => void;
  isDismissed: (stepId: string) => boolean;
  markDismissed: (stepId: string) => void;
}

const CoachmarkContext = createContext<CoachmarkContextValue | null>(null);

export function CoachmarkProvider({ children }: { children: ReactNode }) {
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [activeTour, setActiveTour] = useState<string | null>(null);

  // Read the persisted dismissed-set + reducer once. Coachmark renderers
  // call `isDismissed` on every render; we keep a ref-style closure via
  // `useStore.getState()` reads to avoid forcing every Coachmark to
  // subscribe to the entire store slice.
  const dismissCoachmark = useStore((s) => s.ui.dismissCoachmark);

  const showStep = useCallback(
    (stepId: string, opts?: { tour?: string }) => {
      // Idempotent — bail if the step is already active so the
      // telemetry stream doesn't double-fire on a re-render race.
      setActiveStep((prev) => {
        if (prev === stepId) return prev;
        void logEvent("coachmark_step_shown", {
          step_id: stepId,
          tour: opts?.tour ?? null,
        });
        return stepId;
      });
      if (opts?.tour) setActiveTour(opts.tour);
    },
    [],
  );

  const dismiss = useCallback(
    (reason: CoachmarkDismissReason = "complete") => {
      setActiveStep((prev) => {
        if (!prev) return null;
        void logEvent("coachmark_dismissed", {
          step_id: prev,
          reason,
        });
        return null;
      });
      // Note: we do NOT auto-clear `activeTour` on dismiss — the
      // FirstRunTour reuses the tour label across consecutive showStep
      // calls. The tour clears the label itself on completion / skip.
    },
    [],
  );

  const isDismissed = useCallback((stepId: string) => {
    return useStore.getState().ui.coachmarksDismissed.includes(stepId);
  }, []);

  const markDismissed = useCallback(
    (stepId: string) => {
      dismissCoachmark(stepId);
    },
    [dismissCoachmark],
  );

  const value = useMemo<CoachmarkContextValue>(
    () => ({
      activeStep,
      activeTour,
      showStep,
      dismiss,
      isDismissed,
      markDismissed,
    }),
    [activeStep, activeTour, showStep, dismiss, isDismissed, markDismissed],
  );

  return (
    <CoachmarkContext.Provider value={value}>
      {children}
    </CoachmarkContext.Provider>
  );
}

/**
 * Hook for any component (Coachmark, FirstRunTour, settings replay
 * trigger) that needs to drive the tour. Throws when used outside the
 * provider so a wiring mistake fails loudly during development. The
 * AppShell mounts the provider above every route, so this never fires
 * in production.
 */
export function useCoachmark(): CoachmarkContextValue {
  const ctx = useContext(CoachmarkContext);
  if (!ctx) {
    throw new Error("useCoachmark must be used inside <CoachmarkProvider/>");
  }
  return ctx;
}

/**
 * Internal escape hatch for tests — lets a test setup clear the active
 * step without going through a Coachmark instance. Not exported from the
 * package; mirror the contract in test setup if you need it.
 */
export function __resetForTests(value?: Partial<CoachmarkContextValue>) {
  // Intentionally a no-op at the module level — the hook is consumed
  // through the provider. Tests should reset the underlying store
  // (`coachmarksDismissed`, `firstRunTourCompleted`) directly.
  void value;
}
// === end wave 22 ===
