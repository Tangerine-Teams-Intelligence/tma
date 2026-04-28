// === v1.15.0 wave 1.2 ===
/**
 * /setup/connect — onboarding wizard "Connect AI tool" step.
 *
 * Wraps <AIToolDetectionGrid/>. The W1.1 SetupWizard renders a card
 * titled "Connect AI tool" whose CTA navigates here; on Esc we go back
 * to the wizard so users can retreat without losing wizard state.
 *
 * The route is intentionally thin — all real logic lives in the grid
 * component. We only own:
 *   - the page chrome (heading + back link),
 *   - the navigation contract (Esc → back, telemetry on entry),
 *   - the route-level focus management (auto-focus the grid region on
 *     mount so the first Tab lands on the first tool card).
 */

import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import AIToolDetectionGrid from "@/components/onboarding/AIToolDetectionGrid";
import { logEvent } from "@/lib/telemetry";

export default function SetupConnectRoute() {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Telemetry on entry — lets analytics see how many users actually
  // reach this step from the SetupWizard CTA. Cast keeps the call
  // site honest until W1.4 registers the event in TelemetryEventName.
  useEffect(() => {
    void logEvent("setup_wizard_opened", { step: "connect" });
    // Move focus to the heading so screen readers announce the route
    // change and Tab lands on the first card next.
    headingRef.current?.focus();
  }, []);

  const onBack = () => navigate(-1);

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Link
          to="/today"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          data-testid="setup-connect-back"
        >
          <ArrowLeft size={12} aria-hidden /> Back
        </Link>

        <header className="mt-6">
          <p className="ti-section-label">Onboarding</p>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-3xl tracking-tight text-stone-900 outline-none dark:text-stone-100"
          >
            Connect an AI tool
          </h1>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
            Tangerine borrows your existing AI tool sessions — pick one we
            detected, or grab the one you use.
          </p>
        </header>

        <div className="mt-8">
          <AIToolDetectionGrid onEscape={onBack} />
        </div>
      </div>
    </div>
  );
}
// === end v1.15.0 wave 1.2 ===
