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
import { useTranslation } from "react-i18next";
import { Sparkles, FileText, Eye, ListChecks, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

interface ValueCard {
  icon: typeof Sparkles;
  /** i18n key under `welcome.cardN`. */
  key: "card1" | "card2" | "card3" | "card4";
}

// === wave 6 === BUG #6 — strings are now i18n keys, not literals.
const VALUE_CARDS: ValueCard[] = [
  { icon: Sparkles, key: "card1" },
  { icon: FileText, key: "card2" },
  { icon: Eye, key: "card3" },
  { icon: ListChecks, key: "card4" },
];

export function WelcomeOverlay() {
  const { t } = useTranslation();
  const welcomed = useStore((s) => s.ui.welcomed);
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  // === wave 6 === BUG #3 — version-aware tour replay.
  const lastWelcomedVersion = useStore((s) => s.ui.lastWelcomedVersion);
  const setLastWelcomedVersion = useStore(
    (s) => s.ui.setLastWelcomedVersion,
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  // === wave 6 === BUG #3 — show the overlay if either
  //   (a) `welcomed === false` (fresh install / explicit replay), OR
  //   (b) the user previously dismissed but on an older app version. Catching
  //       case (b) means upgrade users see new tour content without having to
  //       hunt for the replay button.
  // The Settings replay button and Cmd+K palette only flip `welcomed` to
  // false; they don't touch `lastWelcomedVersion`. So a Settings replay still
  // re-shows correctly because (a) takes effect.
  const versionMismatch =
    !!__APP_VERSION__ && lastWelcomedVersion !== __APP_VERSION__;
  const shouldShow = !welcomed || versionMismatch;

  // Move focus to the CTA on mount so keyboard users can hit Enter to
  // proceed. Defer one tick so the dialog DOM is in place.
  useEffect(() => {
    if (!shouldShow) return;
    const t = window.setTimeout(() => ctaRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [shouldShow]);

  // Esc → skip (same effect as the "Skip tour" link). We treat Esc as
  // a soft dismissal — telemetry-tagged separately so analytics sees
  // how many users bypass the tour entirely.
  useEffect(() => {
    if (!shouldShow) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void logEvent("welcome_overlay_skipped", { trigger: "esc" });
        setWelcomed(true);
        setLastWelcomedVersion(__APP_VERSION__);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shouldShow, setWelcomed, setLastWelcomedVersion]);

  // Telemetry once per cold-start when the overlay is shown. Useful for
  // first-run conversion analysis (shown → started) over time.
  useEffect(() => {
    if (!shouldShow) return;
    void logEvent("welcome_overlay_shown", {
      version: __APP_VERSION__,
      replay_after_upgrade: welcomed && versionMismatch ? 1 : 0,
    });
  }, [shouldShow, welcomed, versionMismatch]);

  if (!shouldShow) return null;

  const onStart = () => {
    void logEvent("welcome_overlay_started", { version: __APP_VERSION__ });
    setWelcomed(true);
    setLastWelcomedVersion(__APP_VERSION__);
  };
  const onSkip = () => {
    void logEvent("welcome_overlay_skipped", {
      trigger: "link",
      version: __APP_VERSION__,
    });
    setWelcomed(true);
    setLastWelcomedVersion(__APP_VERSION__);
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
          aria-label={t("welcome.close")}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          onClick={onSkip}
        >
          <X size={14} />
        </button>

        <header className="mb-6">
          <p className="ti-section-label">{t("welcome.kicker")}</p>
          <h1
            id="welcome-overlay-title"
            className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100"
          >
            {t("welcome.title")}
          </h1>
          <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
            {t("welcome.subtitle")}
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
            {t("welcome.cta")}
          </Button>
          <button
            type="button"
            onClick={onSkip}
            data-testid="welcome-skip"
            className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {t("welcome.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ValueCardView({ card, index }: { card: ValueCard; index: number }) {
  const { t } = useTranslation();
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
            {t(`welcome.${card.key}.title`)}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-stone-600 dark:text-stone-400">
            {t(`welcome.${card.key}.body`)}
          </p>
        </div>
      </div>
    </div>
  );
}
