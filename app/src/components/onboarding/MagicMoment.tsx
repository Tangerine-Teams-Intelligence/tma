/**
 * v1.16 Wave 3 Agent C1 — Magic Moment 4-step onboarding.
 *
 * Replaces the wave-11 SetupWizard / wave-1.16 砍 OnboardingChat. New
 * thesis: 30 seconds. Step 1 (10s headline) → Step 2 (10s sample
 * captures auto-scrub) → Step 3 (10s source pickers) → Step 4 (instant
 * confirmation). Total goal time-to-/feed = 30s. ESC at any step
 * closes early but still flips `welcomed=true` so the user is never
 * re-prompted on subsequent cold launches.
 *
 * Mount gating lives in AppShell — this component assumes it's only
 * rendered for fresh users. Internally we still self-close (rather
 * than unmount externally) to keep the parent layer dumb.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "@/lib/store";
import { Step1Welcome } from "./Step1Welcome";
import { Step2Animation } from "./Step2Animation";
import { Step3Sources } from "./Step3Sources";
import { Step4Done } from "./Step4Done";

export type MagicStep = 1 | 2 | 3 | 4;

interface MagicMomentProps {
  /** Optional override — defaults to /feed (matches Wave 2 default
   *  landing surface). Tests pass a stub navigator to assert. */
  feedPath?: string;
}

export function MagicMoment({ feedPath = "/feed" }: MagicMomentProps) {
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  const navigate = useNavigate();
  const [step, setStep] = useState<MagicStep>(1);
  // Allow the modal to fully unmount on close so a re-mount cycle (e.g.
  // a future story-edit case) restarts cleanly at step 1.
  const [open, setOpen] = useState(true);

  // === keyboard handling ===
  // Step 1: ↓ / Enter / Space → step 2.
  // Any step: ESC → close + setWelcomed(true).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (step === 1) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setStep(2);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open]);

  function close() {
    setWelcomed(true);
    setOpen(false);
  }

  function enterFeed() {
    setWelcomed(true);
    setOpen(false);
    navigate(feedPath);
  }

  if (!open) return null;

  return (
    <div
      data-testid="magic-moment"
      data-step={step}
      role="presentation"
      // Inset-0 fixed full-viewport overlay. Backdrop is dark + blurred
      // so the surrounding shell visually steps back. We do NOT mount
      // any AppShell content underneath — the magic moment owns the
      // entire visible area for ~30s.
      className="fixed inset-0 z-[80] flex flex-col bg-black/85 backdrop-blur-sm"
    >
      {step === 1 && (
        <Step1Welcome
          onAdvance={() => setStep(2)}
          onSkip={close}
        />
      )}
      {step === 2 && (
        <Step2Animation
          onAdvance={() => setStep(3)}
          onSkip={close}
        />
      )}
      {step === 3 && (
        <Step3Sources
          onConfirm={() => setStep(4)}
          onSkip={close}
        />
      )}
      {step === 4 && <Step4Done onEnter={enterFeed} />}
    </div>
  );
}
