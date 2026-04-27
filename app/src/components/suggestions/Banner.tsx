/**
 * v1.9.0-beta.1 — Banner tier component.
 *
 * Spec ref: SUGGESTION_ENGINE_SPEC.md §3.2.
 *
 * Persistent strip mounted between the top nav bar and the route Outlet.
 * The shell decides which banner to render via `<BannerHost/>` — this
 * component is a "dumb" presentational layer that takes a `BannerProps`
 * and renders it. The host owns the queue / max-1-active enforcement.
 *
 * Visual contract (matches InlineReaction's brand language):
 *   - Full-width strip below the WhatsNewBanner / localOnly strip.
 *   - 🍊 brand-orange dot at the left identifies the AGI as the source.
 *   - Body text fills the middle. Optional CTA button + dismiss × at right.
 *   - Brand orange #CC5500 left border + ink-700 text per §3.2 spec.
 *
 * Lifetime: until user dismisses OR the underlying condition resolves
 * (re-render with empty stack). Banner is mounted from BannerHost which
 * picks the highest-priority entry in `bannerStack`.
 */

import { useCallback } from "react";
import { X } from "lucide-react";

export interface BannerProps {
  /** Stable id for dismiss tracking + queue identity. */
  id: string;
  /** Override the default 🍊 dot. Rare — system banners might use 🛠. */
  emoji?: string;
  /** Body text. Plain string for v1.9.0-beta.1 (markdown lands in -beta.2). */
  body: string;
  ctaLabel?: string;
  /** Internal route or external href; treated as plain navigation. */
  ctaHref?: string;
  /** Fired on the × dismiss button. */
  onDismiss?: () => void;
  /** Fired on the CTA button. Has priority over `ctaHref` if both set. */
  onAccept?: () => void;
  /** 0..10; higher wins when multiple banners contend. Default 5. */
  priority?: number;
  /** When false, the × is hidden and only `onAccept` can clear the banner. */
  dismissable?: boolean;
}

/**
 * Pure presentational component. The host wraps it with the right
 * onDismiss / onAccept that pop the banner off the queue.
 */
export function Banner({
  id,
  emoji = "🍊",
  body,
  ctaLabel,
  ctaHref,
  onDismiss,
  onAccept,
  dismissable = true,
}: BannerProps) {
  const handleAccept = useCallback(() => {
    if (onAccept) {
      onAccept();
      return;
    }
    if (ctaHref) {
      // Plain navigation — keep this dependency-free so the banner doesn't
      // need a Router parent. Components mounting Banner inside the AppShell
      // already live under <BrowserRouter>, but tests render Banner in
      // isolation.
      if (typeof window !== "undefined") {
        window.location.href = ctaHref;
      }
    }
  }, [ctaHref, onAccept]);

  return (
    <div
      data-testid="suggestion-banner"
      data-banner-id={id}
      role="status"
      aria-live="polite"
      className="ti-no-select flex items-center gap-3 border-b border-l-4 border-stone-200 border-l-[var(--ti-orange-500,#CC5500)] bg-[var(--ti-orange-50,#FFF5EC)] px-4 py-2 text-[12px] text-stone-700 dark:border-stone-700 dark:border-l-[var(--ti-orange-500,#CC5500)] dark:bg-stone-900 dark:text-stone-200"
    >
      <span
        aria-hidden
        className="inline-block flex-shrink-0 text-[14px]"
        title="Tangerine"
      >
        {/* The 🍊 dot is the AGI's signature — same as the chip tier. We
         *  use the literal emoji so the brand is consistent regardless of
         *  font availability. */}
        {emoji}
      </span>
      <span className="flex-1 leading-snug">{body}</span>
      {ctaLabel && (
        <button
          type="button"
          onClick={handleAccept}
          data-testid="suggestion-banner-cta"
          className="rounded border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-100,#FFE4CD)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-200,#FFD0A8)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-700"
        >
          {ctaLabel}
        </button>
      )}
      {dismissable && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="suggestion-banner-dismiss"
          className="text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
