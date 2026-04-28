// === wave 1.15 W2.1 ===
/**
 * Wave 1.15 W2.1 — DemoTourOverlay.
 *
 * 5-step non-blocking guided tour that runs once after the user enters
 * demo mode (W1.1 SetupWizard "Try with sample data" card → flips
 * `demoMode = true`). The overlay sits above the AppShell at z-50 but
 * deliberately does NOT lock pointer events on the surfaces behind it —
 * the user can still click the sidebar / sample atoms while the tour is
 * showing. The dialog itself has a focus trap + Esc-to-dismiss + Tab
 * cycling so screen-reader and keyboard-only users can navigate it.
 *
 * Steps:
 *   1. Memory tree    (route /memory)    — atoms storage explainer
 *   2. People         (route /people)    — auto-surfaced teammates
 *   3. Threads        (route /threads)   — AI mention extraction
 *   4. Co-Thinker     (route /co-thinker)— continuous reasoning over team work
 *   5. Ready for real?                   — Clear-samples + exit demo CTA
 *
 * The "Try real data" CTA on step 5 calls `demoSeedClear` (Rust
 * `demo_seed_clear` command — verified by grep on src-tauri) so the
 * R9-isolated sample files are removed from disk, then flips
 * `demoMode = false` + `demoTourCompleted = true` and routes to
 * `/setup` to send the user back into the SetupWizard's Connect-AI-tool
 * flow. Skipping at any step flips ONLY `demoTourCompleted = true` —
 * `demoMode` stays as-is so the user can keep browsing sample data
 * without the tour reappearing every cold launch.
 *
 * Telemetry contract (W1.4 owns telemetry.ts):
 *   - `demo_tour_step_completed` (props: { step_index: number }) — fired
 *      each time the user advances past a step.
 *   - `demo_to_real_conversion`  (props: { from_step: number,
 *      cleared_files: number }) — fired after step-5 Clear-samples
 *      succeeds (i.e. real conversion confirmed).
 *   - `demo_tour_dismissed` (props: { at_step: number }) — fired on any
 *      Skip / Esc dismiss. Wave 4 wire-up: now in the union (Wave 2.1
 *      block) — casts have been removed.
 *
 * Mount logic lives in AppShell (caller side): mount this component when
 * `ui.demoMode === true && ui.demoTourCompleted === false`. The overlay
 * itself also re-checks both flags so it self-hides if the AppShell gate
 * fails to drop us.
 *
 * A11y:
 *   - role="dialog" + aria-modal="false" (non-blocking — user can still
 *      click main UI behind us)
 *   - aria-labelledby + aria-describedby pointing at heading + body
 *   - Esc dismisses (treated as a Skip → flip latch + emit dismiss event)
 *   - Tab / Shift+Tab cycle focus inside the dialog body
 *   - Focus is moved to the dialog on mount and restored on unmount
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { demoSeedClear } from "@/lib/tauri";

interface TourStep {
  /** 0-indexed; matches the telemetry payload `step_index`. */
  index: number;
  /** i18n-free copy — the build prompt's exact strings (Chinese, no
   *  marketing fluff per Daizhe's voice rule). */
  title: string;
  body: string;
  /** Route to which clicking the step's "go look at it" affordance
   *  navigates. Step 5 has no route — the action is the conversion CTA. */
  route: string | null;
  /** data-testid on the surface this step is meant to highlight. The
   *  highlight is purely visual (a soft ring around the existing test
   *  hook); we never block interaction with the surface. */
  highlightTestId: string | null;
}

const STEPS: TourStep[] = [
  {
    index: 0,
    title: "Memory tree",
    body: "你的所有 atom 在这。每次跟 AI 说话都自动落下一个 markdown.",
    route: "/memory",
    highlightTestId: "sidebar-nav-memory",
  },
  {
    index: 1,
    title: "People",
    body: "队友自动浮现。每个人有他们 capture 的 atom 流.",
    route: "/people",
    highlightTestId: "sidebar-nav-people",
  },
  {
    index: 2,
    title: "Threads",
    body: "AI 抽 @mention 的对话自动 thread 化.",
    route: "/threads",
    highlightTestId: "sidebar-nav-threads",
  },
  {
    index: 3,
    title: "Co-Thinker",
    body: "AI 持续对你团队的工作做推理.",
    route: "/co-thinker",
    highlightTestId: "sidebar-nav-co-thinker",
  },
  {
    index: 4,
    title: "Ready for real?",
    body: "这是 sample data. 准备好用真数据 →",
    route: null,
    highlightTestId: null,
  },
];

export function DemoTourOverlay() {
  const navigate = useNavigate();
  const demoMode = useStore((s) => s.ui.demoMode);
  const demoTourCompleted = useStore((s) => s.ui.demoTourCompleted);
  const setDemoMode = useStore((s) => s.ui.setDemoMode);
  const setDemoTourCompleted = useStore((s) => s.ui.setDemoTourCompleted);

  const [stepIndex, setStepIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const bodyId = useId();

  const shouldRender = demoMode && !demoTourCompleted;
  const step = STEPS[stepIndex] ?? null;

  // Focus management: capture the previously-focused element on mount so
  // we can restore it on unmount; move focus into the dialog so screen
  // readers / keyboard users land inside the new region.
  useEffect(() => {
    if (!shouldRender) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer one frame so the dialog ref is populated.
    const handle = window.requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(handle);
      previouslyFocused.current?.focus?.();
    };
  }, [shouldRender]);

  // Skip / dismiss handler — used by Esc, Skip button, and the X button.
  // Flips ONLY the completion latch; demoMode stays so the user can keep
  // browsing sample data after dismissing the tour.
  const handleDismiss = useCallback(
    (atStep: number) => {
      setDemoTourCompleted(true);
      void logEvent("demo_tour_dismissed", { at_step: atStep });
    },
    [setDemoTourCompleted],
  );

  // Esc-to-dismiss + Tab focus trap. We listen at window level (capture
  // phase) so the handler fires even when focus is outside the dialog
  // (e.g. user clicked a sample atom in the background and pressed Esc).
  useEffect(() => {
    if (!shouldRender) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDismiss(stepIndex);
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        // Focus trap: keep tab cycling inside the dialog. We collect
        // focusable elements at handler time so dynamically added /
        // removed buttons (Next vs Try-real on step 5) are picked up.
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shouldRender, stepIndex, handleDismiss]);

  if (!shouldRender || !step) return null;

  // Advance one step. Step 1-4 just bump the index; step 5 is handled
  // by the dedicated "Try real data" CTA below (NOT by Next).
  const handleNext = () => {
    void logEvent("demo_tour_step_completed", { step_index: stepIndex });
    if (step.route) {
      // Best-effort route the user to the surface so the next step's
      // explanation matches what they're looking at. Failure to navigate
      // is non-fatal — the next step still renders.
      try {
        navigate(step.route);
      } catch {
        // Router not available (test harness without router) — ignore.
      }
    }
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  };

  // Step 5 conversion path: Clear sample files via Rust, drop demoMode,
  // mark the tour completed, route to /setup. Telemetry payload includes
  // the actual cleared_files count from the Rust response so we can
  // detect the "user clicked but disk was already empty" edge case.
  const handleTryReal = async () => {
    let clearedFiles = 0;
    try {
      const res = await demoSeedClear();
      clearedFiles = res.removed_files;
    } catch {
      // Clear failed — log telemetry anyway so we can see the rate of
      // failures, but proceed with the flag flip + navigation. Leaving
      // sample data on disk after a failed clear is acceptable; the
      // user can re-trigger via Settings → Clear samples.
    }
    void logEvent(
      "demo_to_real_conversion",
      { from_step: stepIndex, cleared_files: clearedFiles },
    );
    // Also mark step 5 as completed so the per-step funnel is intact.
    void logEvent("demo_tour_step_completed", { step_index: stepIndex });
    setDemoMode(false);
    setDemoTourCompleted(true);
    try {
      navigate("/setup");
    } catch {
      // Same as above — ignore router unavailability.
    }
  };

  const isFinal = step.index === STEPS.length - 1;

  return (
    <div
      // Backdrop is intentionally transparent + pointer-events-none so
      // the overlay does NOT lock the main UI. Only the dialog card
      // captures pointer events.
      className="pointer-events-none fixed inset-0 z-50 flex items-end justify-end p-6"
      data-testid="demo-tour-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="pointer-events-auto w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 text-zinc-100 shadow-2xl outline-none focus:ring-2 focus:ring-orange-500"
        data-testid="demo-tour-dialog"
        data-step-index={stepIndex}
      >
        <div className="mb-3 flex items-center justify-between">
          <span
            className="text-xs uppercase tracking-wide text-zinc-400"
            data-testid="demo-tour-step-label"
          >
            {`Step ${stepIndex + 1} of ${STEPS.length}`}
          </span>
          <button
            type="button"
            onClick={() => handleDismiss(stepIndex)}
            className="text-zinc-400 hover:text-zinc-100"
            aria-label="Close demo tour"
            data-testid="demo-tour-close"
          >
            ×
          </button>
        </div>
        <h2
          id={headingId}
          className="mb-2 text-lg font-semibold"
          data-testid="demo-tour-title"
        >
          {step.title}
        </h2>
        <p
          id={bodyId}
          className="mb-5 text-sm leading-relaxed text-zinc-300"
          data-testid="demo-tour-body"
        >
          {step.body}
        </p>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => handleDismiss(stepIndex)}
            className="text-sm text-zinc-400 hover:text-zinc-100"
            data-testid="demo-tour-skip"
          >
            Skip
          </button>
          {isFinal ? (
            <button
              type="button"
              onClick={() => {
                void handleTryReal();
              }}
              className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500"
              data-testid="demo-tour-try-real"
            >
              用真数据
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500"
              data-testid="demo-tour-next"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
// === end wave 1.15 W2.1 ===
