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

import { useCallback, useState } from "react";
import { X } from "lucide-react";

/** Polish 4 (v1.9.0-beta.3) — duration of the green accept-flash. Kept
 *  in sync with the `ti-accept-flash` keyframe in `index.css`. The host
 *  waits this long before popping the banner off the queue. */
const ACCEPT_FLASH_MS = 200;

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
  // Polish 4 (v1.9.0-beta.3) — flash green for ACCEPT_FLASH_MS before
  // running the user's onAccept. We don't want to swallow the click —
  // the parent's handler still fires immediately so any side-effects
  // (navigation, queue pop) happen synchronously.
  const [accepting, setAccepting] = useState(false);

  const handleAccept = useCallback(() => {
    setAccepting(true);
    // Use a microtask so the className change paints before the
    // host unmounts us. We keep the original onAccept eager so the
    // queue pop happens within the 200ms window.
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
      // Polish 2 (v1.9.0-beta.3) — banners are non-blocking but they
      // are time-sensitive content the AGI surfaced to the user.
      // role="alert" + aria-live="polite" lets screen readers announce
      // the body without yanking focus. The combination is the
      // recommended pattern for non-modal advisory strips.
      role="alert"
      aria-live="polite"
      className={
        // Polish 1 (v1.9.0-beta.3) — base background uses --ti-bg-elevated
        // so the strip sits above the route content in both light + dark.
        // The orange-50 wash from beta.1 is preserved as a layered tint via
        // the left border + top-light backdrop; in dark we drop the wash to
        // keep contrast against the navy body bg.
        "ti-no-select flex items-center gap-3 border-b border-l-4 border-[var(--ti-border-default)] border-l-[var(--ti-orange-500)] bg-[var(--ti-bg-elevated)] px-4 py-2 text-[12px] text-[var(--ti-ink-700)]" +
        (accepting ? " ti-accept-flash" : "")
      }
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
          // Polish 2 — focusable button is keyboard-accessible by default
          // (Tab → focus → Enter → click). focus-visible styles add an
          // outline so the user can see where focus is. The orange tokens
          // are shared light/dark via the keyword vars added in Polish 1.
          className="rounded border border-[var(--ti-orange-300)] bg-[var(--ti-orange-100)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-700"
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
          // Polish 2 — Tab + Enter on the × dismisses (default <button>
          // semantics). focus-visible adds a ring so keyboard users can
          // see where focus landed.
          className="rounded text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-900)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)]"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
