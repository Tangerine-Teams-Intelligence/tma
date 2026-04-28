// === wave 22 ===
/**
 * Wave 22 — FirstRunTour.
 *
 * 6-step coachmark sequence that runs once after WelcomeOverlay +
 * SetupWizard / OnboardingChat finish. Mounted in AppShell so it's
 * always available; gated on:
 *   - `firstRunTourCompleted === false` (persisted), AND
 *   - `demoMode === true`               (sample data is on disk so the
 *      coachmark targets actually have something to point at).
 *
 * Steps:
 *   1. stat       → today-stat-strip          ("daily snapshot")
 *   2. hero       → today-chat-input          ("ask anything")
 *   3. decisions  → dashboard-recent-decisions ("recent decisions")
 *   4. activity   → dashboard-todays-activity  ("live activity")
 *   5. memory     → sidebar-nav-memory          ("file tree")
 *   6. brain      → sidebar-nav-brain           ("agi-summarized doc")
 *
 * On the final step the primary CTA reads "Got it" and dismissing it
 * flips the persisted latch + emits `tour_completed`. Skip at any step
 * also flips the latch (the tour is opt-in past first-run; you don't
 * want to nag the user every cold launch).
 *
 * The route is locked to /today for the first 4 steps because that's
 * where the targets live; for steps 5 + 6 we point at sidebar items
 * which exist on every route, so we don't enforce a route there.
 *
 * Failure-mode contract: if a step's target is missing, the Coachmark
 * itself dismisses with reason "outside" and calls our `onNext` so the
 * tour skips forward instead of stalling. This is the documented
 * "graceful skip" behavior the build prompt asks for.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { Coachmark, type CoachmarkPlacement } from "./Coachmark";
import { useCoachmark } from "./CoachmarkProvider";

const TOUR_NAME = "first_run";

interface TourStep {
  id: string;
  /** i18n sub-key under `coachmark.tour.{key}.{title|body}`. */
  key: "stat" | "hero" | "decisions" | "activity" | "memory" | "brain";
  targetSelector: string;
  placement: CoachmarkPlacement;
  /** Route the user must be on for this step. Null = any route. */
  requiredRoute: string | null;
}

const STEPS: TourStep[] = [
  {
    id: "first_run.stat",
    key: "stat",
    targetSelector: '[data-testid="today-stat-strip"]',
    placement: "bottom",
    requiredRoute: "/today",
  },
  {
    id: "first_run.hero",
    key: "hero",
    targetSelector: '[data-testid="today-chat-input"]',
    placement: "bottom",
    requiredRoute: "/today",
  },
  {
    id: "first_run.decisions",
    key: "decisions",
    targetSelector: '[data-testid="dashboard-recent-decisions"]',
    placement: "top",
    requiredRoute: "/today",
  },
  {
    id: "first_run.activity",
    key: "activity",
    targetSelector: '[data-testid="dashboard-todays-activity"]',
    placement: "top",
    requiredRoute: "/today",
  },
  {
    id: "first_run.memory",
    key: "memory",
    targetSelector: '[data-testid="sidebar-nav-memory"]',
    placement: "right",
    requiredRoute: null,
  },
  {
    id: "first_run.brain",
    key: "brain",
    targetSelector: '[data-testid="sidebar-nav-brain"]',
    placement: "right",
    requiredRoute: null,
  },
];

export function FirstRunTour() {
  const { t } = useTranslation();
  const location = useLocation();
  const firstRunTourCompleted = useStore(
    (s) => s.ui.firstRunTourCompleted,
  );
  const demoMode = useStore((s) => s.ui.demoMode);
  const setupWizardChannelReady = useStore(
    (s) => s.ui.setupWizardChannelReady,
  );
  const welcomed = useStore((s) => s.ui.welcomed);
  const setFirstRunTourCompleted = useStore(
    (s) => s.ui.setFirstRunTourCompleted,
  );
  const { activeStep, showStep, dismiss } = useCoachmark();
  const [stepIndex, setStepIndex] = useState<number>(-1);

  // Decide whether to mount at all. Conditions stack:
  //   - tour not completed
  //   - demo data on disk (so the coachmark targets render)
  //   - WelcomeOverlay finished (welcomed=true) + chat onboarding done
  const shouldMount =
    !firstRunTourCompleted &&
    demoMode &&
    welcomed &&
    setupWizardChannelReady;

  // Auto-start the tour on mount. We give a small beat (250ms) so the
  // dashboard widgets have a chance to land their data fetch + paint.
  useEffect(() => {
    if (!shouldMount) return;
    if (stepIndex !== -1) return;
    const handle = window.setTimeout(() => {
      setStepIndex(0);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [shouldMount, stepIndex]);

  // Whenever the step index changes, push the corresponding step into
  // the active slot via the provider. The Coachmark component will
  // render itself once its `step` matches.
  useEffect(() => {
    if (!shouldMount) return;
    if (stepIndex < 0 || stepIndex >= STEPS.length) return;
    const next = STEPS[stepIndex];
    // Route gate: if the step requires a specific route and the user is
    // elsewhere, skip past it gracefully. Lets a user who Cmd+K-jumped
    // to /memory mid-tour still see the sidebar steps.
    if (next.requiredRoute && location.pathname !== next.requiredRoute) {
      setStepIndex((i) => i + 1);
      return;
    }
    showStep(next.id, { tour: TOUR_NAME });
  }, [shouldMount, stepIndex, showStep, location.pathname]);

  // Listen for activeStep going null when we're mid-tour — that's the
  // signal that a Coachmark dismissed itself. Advance unless we just
  // finished the last step, in which case we mark the tour complete.
  useEffect(() => {
    if (!shouldMount) return;
    if (stepIndex < 0) return;
    if (activeStep !== null) return; // Coachmark still showing — wait.
    if (stepIndex >= STEPS.length) return;
    // Race guard: bump on next tick so a same-tick re-render doesn't
    // double-advance.
    const handle = window.setTimeout(() => {
      setStepIndex((i) => i + 1);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [activeStep, shouldMount, stepIndex]);

  // Final-step completion latch.
  useEffect(() => {
    if (!shouldMount) return;
    if (stepIndex < STEPS.length) return;
    setFirstRunTourCompleted(true);
    void logEvent("tour_completed", { tour: TOUR_NAME });
  }, [shouldMount, stepIndex, setFirstRunTourCompleted]);

  const currentStep = useMemo(() => {
    if (stepIndex < 0 || stepIndex >= STEPS.length) return null;
    return STEPS[stepIndex];
  }, [stepIndex]);

  if (!shouldMount) return null;
  if (!currentStep) return null;

  const isFinal = stepIndex === STEPS.length - 1;
  const titleKey = `coachmark.tour.${currentStep.key}.title`;
  const bodyKey = `coachmark.tour.${currentStep.key}.body`;

  return (
    <Coachmark
      step={currentStep.id}
      targetSelector={currentStep.targetSelector}
      title={t(titleKey)}
      body={t(bodyKey)}
      stepLabel={t("coachmark.stepLabel", {
        current: stepIndex + 1,
        total: STEPS.length,
      })}
      isFinal={isFinal}
      placement={currentStep.placement}
      onNext={() => {
        // The Coachmark component already dismissed itself (which
        // triggers our `activeStep === null` advance effect). Nothing
        // more to do here — but if the user wants the final step to
        // explicitly land on the completion banner, we can stamp it
        // here too.
        if (isFinal) {
          setFirstRunTourCompleted(true);
          void logEvent("tour_completed", { tour: TOUR_NAME });
        }
      }}
      onSkip={() => {
        // Skip at any step retires the whole tour — same persisted
        // latch as completing it. This is intentional: the tour is
        // opt-in by design (CEO ratification), and a user who clicks
        // Skip really doesn't want to see it again next launch.
        setFirstRunTourCompleted(true);
        dismiss("skip");
        setStepIndex(STEPS.length); // jump past the last step.
      }}
    />
  );
}
// === end wave 22 ===
