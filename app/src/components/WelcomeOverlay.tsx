/**
 * Wave 4-C — first-run welcome overlay.
 *
 * Mounted by AppShell on every route. Renders a modal overlay with 4
 * value-prop cards on the very first launch, then self-dismisses by
 * flipping `ui.welcomed` to `true` (persisted, so the overlay only ever
 * shows once per install).
 *
 * Why this exists: the CEO asked for "好用好上手 30 秒 onboarding". A
 * first-time user who lands on /today doesn't yet understand what
 * Tangerine is. The 4 cards surface the four design pillars in <5
 * seconds:
 *   1. We don't take a new AI subscription — we borrow yours.
 *   2. The AGI brain is a markdown doc — readable, editable, git-able.
 *   3. We watch your AI tools across vendors so the team sees the full
 *      picture.
 *   4. Sidebar shows which 10 AI tools we've aligned.
 *
 * One CTA ("Get started in 30 seconds") + a "Skip tour" link. Both
 * paths flip `welcomed = true`. The CTA closes the overlay so the user
 * lands directly on /today's hero card; the skip path same. We don't
 * navigate — the route the user is already on stays put.
 *
 * Accessibility: focus-trapped to the dialog; Esc dismisses (treated as
 * "skip"); the backdrop click does NOT dismiss (forces an explicit
 * decision so the value props get a beat to register).
 */

import { useEffect, useRef } from "react";
import { Sparkles, FileText, Eye, ListChecks, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

interface ValueCard {
  icon: typeof Sparkles;
  title: string;
  body: string;
}

const VALUE_CARDS: ValueCard[] = [
  {
    icon: Sparkles,
    title: "No new AI subscription",
    body: "We borrow your existing Cursor / Claude Pro / ChatGPT session. Your team's AGI runs on the AI you already pay for.",
  },
  {
    icon: FileText,
    title: "Your AGI brain is a markdown doc",
    body: "Readable, editable, git-able. Open `co-thinker.md` to see exactly what the AGI is thinking — edit it to steer.",
  },
  {
    icon: Eye,
    title: "Cross-vendor visibility",
    body: "We watch every AI tool your team uses (Cursor, Codex, Claude, ChatGPT, Devin, Replit, Copilot, Windsurf, Gemini, Ollama). The full picture, in one place.",
  },
  {
    icon: ListChecks,
    title: "10 AI tools aligned",
    body: "The sidebar shows which tools we've wired in and which one is your starred ⭐ primary. Add more in seconds.",
  },
];

export function WelcomeOverlay() {
  const welcomed = useStore((s) => s.ui.welcomed);
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to the CTA on mount so keyboard users can hit Enter to
  // proceed. Defer one tick so the dialog DOM is in place.
  useEffect(() => {
    if (welcomed) return;
    const t = window.setTimeout(() => ctaRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [welcomed]);

  // Esc → skip (same effect as the "Skip tour" link). We treat Esc as
  // a soft dismissal — telemetry-tagged separately so analytics sees
  // how many users bypass the tour entirely.
  useEffect(() => {
    if (welcomed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void logEvent("welcome_overlay_skipped", { trigger: "esc" });
        setWelcomed(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [welcomed, setWelcomed]);

  // Telemetry once per cold-start when the overlay is shown. Useful for
  // first-run conversion analysis (shown → started) over time.
  useEffect(() => {
    if (welcomed) return;
    void logEvent("welcome_overlay_shown", {});
  }, [welcomed]);

  if (welcomed) return null;

  const onStart = () => {
    void logEvent("welcome_overlay_started", {});
    setWelcomed(true);
  };
  const onSkip = () => {
    void logEvent("welcome_overlay_skipped", { trigger: "link" });
    setWelcomed(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-950/60 px-4 py-6 backdrop-blur-sm"
      data-testid="welcome-overlay"
      aria-modal="true"
      role="dialog"
      aria-labelledby="welcome-overlay-title"
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-2xl rounded-lg border border-stone-200 bg-white p-8 shadow-2xl dark:border-stone-800 dark:bg-stone-900"
      >
        <button
          type="button"
          aria-label="Close welcome tour"
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          onClick={onSkip}
        >
          <X size={14} />
        </button>

        <header className="mb-6">
          <p className="ti-section-label">Welcome to Tangerine</p>
          <h1
            id="welcome-overlay-title"
            className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100"
          >
            Your team's AGI, in 30 seconds.
          </h1>
          <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
            Four things to know before you start.
          </p>
        </header>

        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          data-testid="welcome-cards"
        >
          {VALUE_CARDS.map((card, idx) => (
            <ValueCardView key={idx} card={card} index={idx} />
          ))}
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-4">
          <Button
            ref={ctaRef}
            onClick={onStart}
            data-testid="welcome-start"
            size="lg"
          >
            Get started in 30 seconds
          </Button>
          <button
            type="button"
            onClick={onSkip}
            data-testid="welcome-skip"
            className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            Skip tour
          </button>
        </div>
      </div>
    </div>
  );
}

function ValueCardView({ card, index }: { card: ValueCard; index: number }) {
  const Icon = card.icon;
  return (
    <div
      className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950"
      data-testid={`welcome-card-${index}`}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ti-orange-500)]/15 text-[var(--ti-orange-500)]"
        >
          <Icon size={14} />
        </div>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-stone-900 dark:text-stone-100">
            {card.title}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-stone-600 dark:text-stone-400">
            {card.body}
          </p>
        </div>
      </div>
    </div>
  );
}
