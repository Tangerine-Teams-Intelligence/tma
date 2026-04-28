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
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sparkles, FileText, Eye, ListChecks, Lock, X, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
// === wave 9 === — borrow-AI SVG replaces the generic Sparkles icon on
// card 1 so design moat #1 ("borrow your AI subscription") reads in one
// glance. The other 3 cards keep their lucide icons.
import { BorrowAIVisual } from "@/components/BorrowAIVisual";

interface ValueCard {
  icon: typeof Sparkles;
  /** i18n key under `welcome.cardN`. */
  key: "card1" | "card2" | "card3" | "card4" | "card5";
  // === wave 8 === — soft tint per card so the 2x2 grid reads as four
  // distinct value props rather than four identical rectangles.
  // Mapped to the new design tokens; each card picks up a different
  // background gradient + icon-bg color.
  tint: "warm" | "cool" | "alive" | "neutral";
  /** Optional CTA — when set, renders a small link below the body. */
  cta?: { labelKey: string; route: string };
}

// === wave 6 === BUG #6 — strings are now i18n keys, not literals.
// === wave 8 === — added per-card `tint` so each value prop carries its
// own visual weight (orange = no-sub, blue = markdown, green = visibility,
// neutral = catalog). Helps the eye chunk the cards in 2 seconds.
// === wave 1.13-A === — added card 5 ("Your data, your machines.") so the
// privacy story lands at first launch. Rotates the tints so card 5 picks
// up the same neutral treatment as card 4 (the grid is now 2x3 on small
// viewports, 3x2 on wider ones — both fit the existing max-w-2xl dialog).
const VALUE_CARDS: ValueCard[] = [
  { icon: Sparkles, key: "card1", tint: "warm" },
  { icon: FileText, key: "card2", tint: "cool" },
  { icon: Eye, key: "card3", tint: "alive" },
  { icon: ListChecks, key: "card4", tint: "neutral" },
  // === wave 1.13-A === — privacy moat. Body copy hammers "0 KB sent to
  // Tangerine ever" so the local-first story lands in 2s. The CTA opens
  // the Settings → Privacy panel so the curious user can verify.
  {
    icon: Lock,
    key: "card5",
    tint: "warm",
    cta: { labelKey: "card5.cta", route: "/settings?tab=privacy" },
  },
  // === end wave 1.13-A ===
];

// === wave 8 === — color recipes for each tint. Inlined as objects so
// dark-mode overrides land on the same surface without mounting a
// stylesheet inside the component.
const TINT_STYLES: Record<
  ValueCard["tint"],
  { bg: string; iconBg: string; iconColor: string }
> = {
  warm: {
    bg: "bg-[var(--ti-orange-50)] dark:bg-[rgba(204,85,0,0.08)]",
    iconBg: "bg-[var(--ti-orange-100)] dark:bg-[rgba(204,85,0,0.18)]",
    iconColor: "text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]",
  },
  cool: {
    bg: "bg-[var(--ti-blue-200)]/40 dark:bg-[var(--ti-paper-200)]",
    iconBg: "bg-[var(--ti-blue-200)] dark:bg-[var(--ti-blue-700)]/40",
    iconColor: "text-[var(--ti-blue-700)] dark:text-[var(--ti-blue-500)]",
  },
  alive: {
    bg: "bg-[var(--ti-green-200)]/40 dark:bg-[rgba(16,185,129,0.08)]",
    iconBg: "bg-[var(--ti-green-200)]/70 dark:bg-[rgba(16,185,129,0.2)]",
    iconColor: "text-[var(--ti-green-500)]",
  },
  neutral: {
    bg: "bg-[var(--ti-paper-200)] dark:bg-[var(--ti-paper-200)]",
    iconBg: "bg-[var(--ti-paper-100)] dark:bg-[var(--ti-paper-100)]",
    iconColor: "text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-700)]",
  },
};

export function WelcomeOverlay() {
  const { t } = useTranslation();
  // === wave 1.13-A === — needed for card 5's "See what stays local →"
  // CTA to navigate into Settings → Privacy.
  const navigate = useNavigate();
  // === end wave 1.13-A ===
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

        {/* === wave 8 === — kicker + title use display serif at hero
            scale (text-display-md = 36px). The eye lands on the title
            first instead of the dense card grid. */}
        <header className="mb-7">
          <p className="ti-section-label">{t("welcome.kicker")}</p>
          <h1
            id="welcome-overlay-title"
            className="mt-2 text-display-md text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
          >
            {t("welcome.title")}
          </h1>
          <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
            {t("welcome.subtitle")}
          </p>
        </header>

        {/* === wave 8 === — gap bumped to gap-6 (was gap-3) so the four
            cards have room to breathe.
            === wave 1.13-A === — grid still uses 2 columns on >= sm; the
            5th card naturally lands as a wide tile in the third row. */}
        {/* === v1.13.2 round-2 === — Layout fix for the 5-card grid.
            Original 2-col layout left card 5 as a lonely half-width tile
            with empty white space to its right (visually broken). The fix:
            cards 1-4 stay in the 2x2 grid; card 5 (Privacy moat) gets its
            own full-width row below. This actually upgrades the visual
            weight of the privacy story rather than burying it. */}
        <div
          className="grid grid-cols-1 gap-6 sm:grid-cols-2"
          data-testid="welcome-cards"
        >
          {VALUE_CARDS.slice(0, 4).map((card, idx) => (
            <ValueCardView
              key={idx}
              card={card}
              index={idx}
              onCtaClick={(route) => {
                void logEvent("welcome_card_cta", {
                  card: card.key,
                  route,
                });
                navigate(route);
                setWelcomed(true);
                setLastWelcomedVersion(__APP_VERSION__);
              }}
            />
          ))}
        </div>
        {VALUE_CARDS.length > 4 && (
          <div className="mt-6" data-testid="welcome-cards-row-2">
            <ValueCardView
              card={VALUE_CARDS[4]}
              index={4}
              onCtaClick={(route) => {
                void logEvent("welcome_card_cta", {
                  card: VALUE_CARDS[4].key,
                  route,
                });
                navigate(route);
                setWelcomed(true);
                setLastWelcomedVersion(__APP_VERSION__);
              }}
            />
          </div>
        )}
        {/* === end v1.13.2 round-2 === */}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {/* === wave 8 === — primary CTA gains an arrow icon and stays
              size=lg; the visual weight is now anchored by both color
              and shape, not just text size. */}
          <Button
            ref={ctaRef}
            onClick={onStart}
            data-testid="welcome-start"
            size="lg"
          >
            {t("welcome.cta")}
            <ArrowRight size={16} aria-hidden />
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

function ValueCardView({
  card,
  index,
  onCtaClick,
}: {
  card: ValueCard;
  index: number;
  onCtaClick?: (route: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = card.icon;
  // === wave 8 === — pick up the per-tint color recipe so each card
  // gets its own visual identity. Lift on hover via `ti-card-lift`.
  const styles = TINT_STYLES[card.tint];
  // === wave 9 === — card 1 swaps the lucide Sparkles for the
  // BorrowAIVisual SVG so the "borrow your AI" story reads in one glance.
  // The other 3 cards keep their wave-8 icon treatment.
  const isBorrowCard = card.key === "card1";
  return (
    <div
      className={`ti-card-lift rounded-lg border border-stone-200 p-5 dark:border-stone-800 ${styles.bg}`}
      data-testid={`welcome-card-${index}`}
    >
      <div className="flex items-start gap-3">
        {isBorrowCard ? (
          // === wave 9 === — full SVG composition with vendor arrows
          // converging on the Tangerine logo.
          <div
            aria-hidden="true"
            className="mt-0.5 flex h-[72px] w-[72px] shrink-0 items-center justify-center"
            data-testid="welcome-card-1-borrow-visual"
          >
            <BorrowAIVisual size={72} />
          </div>
        ) : (
          <div
            aria-hidden="true"
            // === wave 8 === — bigger icon (32px box, 18px icon, was 28/14)
            // wrapped in a circular tint background per card.
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${styles.iconBg} ${styles.iconColor}`}
          >
            <Icon size={18} />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]">
            {t(`welcome.${card.key}.title`)}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-500)]">
            {t(`welcome.${card.key}.body`)}
          </p>
          {/* === wave 1.13-A === — optional CTA link (e.g. card 5 →
              Settings → Privacy). Only renders when the card declared a
              `cta` and the parent provided a click handler. */}
          {card.cta && onCtaClick && (
            <button
              type="button"
              data-testid={`welcome-card-${index}-cta`}
              onClick={() => onCtaClick(card.cta!.route)}
              className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
            >
              {t(`welcome.${card.cta.labelKey}`)} <span aria-hidden>→</span>
            </button>
          )}
          {/* === end wave 1.13-A === */}
        </div>
      </div>
    </div>
  );
}
