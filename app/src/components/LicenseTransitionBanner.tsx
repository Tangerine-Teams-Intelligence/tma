import { useEffect, useState } from "react";

/**
 * v1.9.0 P4-B — License flip banner.
 *
 * Surfaces the in-progress Apache 2.0 → AGPL v3 + Dual Commercial transition
 * inside the app so power users see the change before it ratifies. The
 * banner is intentionally low-key (amber strip, single dismiss `×`) and
 * never blocks UI — once dismissed it stays hidden across reloads via
 * `localStorage.tangerine_license_banner_dismissed`.
 *
 * Visibility rules:
 *   - dev mode (`import.meta.env.MODE === "development"`) → always show
 *     so contributors see the transition during local iteration
 *   - prod → show until the user dismisses, then never again on this
 *     install (the localStorage flag is per-origin, persists indefinitely)
 *
 * Removed once the license officially ratifies — at that point the
 * "transition draft" framing is wrong and we'll either delete this
 * component or repurpose it as a one-shot "license has changed" notice.
 */
export const LICENSE_BANNER_DISMISS_KEY = "tangerine_license_banner_dismissed";

export function LicenseTransitionBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(LICENSE_BANNER_DISMISS_KEY) === "true";
    } catch {
      // localStorage can throw in strict-private modes; fall through to visible
      return false;
    }
  });

  // Re-read on mount in case the user toggled the flag from devtools while the
  // component was mounted. Cheap; only runs once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(LICENSE_BANNER_DISMISS_KEY);
      if (v === "true" && !dismissed) setDismissed(true);
    } catch {
      // ignore
    }
  }, [dismissed]);

  const isDev =
    typeof import.meta !== "undefined" &&
    (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE ===
      "development";

  // In dev mode the banner is always visible; in prod we honour the
  // dismiss flag.
  if (!isDev && dismissed) return null;

  function handleDismiss() {
    try {
      window.localStorage.setItem(LICENSE_BANNER_DISMISS_KEY, "true");
    } catch {
      // best-effort; if localStorage is blocked the banner just reappears
      // on next mount, which is acceptable
    }
    setDismissed(true);
  }

  return (
    // === wave 8 === — banner tone dropped from yellow/amber (alarming)
    // to paper-200 (subtle warm grey). "License transition" → "License"
    // so the strip reads as informational, not breaking. AGPL link
    // preserved per spec.
    <div
      data-testid="license-transition-banner"
      className="flex h-7 items-center gap-2 border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-200)] px-3 text-[11px] text-[var(--ti-ink-600)] dark:border-stone-800 dark:text-[var(--ti-ink-500)]"
    >
      <span className="truncate">
        <span className="font-semibold text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-700)]">License</span>: AGPL v3 draft —{" "}
        <a
          href="https://github.com/Tangerine-Intelligence/tangerine-meeting-live/blob/main/LICENSE"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--ti-orange-700)] underline-offset-2 hover:underline dark:text-[var(--ti-orange-500)]"
        >
          LICENSE
        </a>{" "}
        for detail.
      </span>
      <button
        type="button"
        aria-label="Dismiss license transition banner"
        data-testid="license-transition-banner-dismiss"
        onClick={handleDismiss}
        className="ml-auto flex-shrink-0 rounded px-1 leading-none text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-100)] hover:text-[var(--ti-ink-900)] dark:hover:bg-stone-800"
      >
        ×
      </button>
    </div>
  );
}
