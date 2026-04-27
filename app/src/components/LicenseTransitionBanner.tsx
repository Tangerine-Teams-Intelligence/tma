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
    <div
      data-testid="license-transition-banner"
      className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-semibold">License transition</span>: Tangerine is moving from Apache 2.0 to AGPL v3 + Dual Commercial.
          Currently <strong>draft</strong> — actual license enforcement begins on ratification.
          See{" "}
          <a
            href="https://github.com/Tangerine-Intelligence/tangerine-meeting-live/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            LICENSE
          </a>
          .
        </div>
        <button
          type="button"
          aria-label="Dismiss license transition banner"
          data-testid="license-transition-banner-dismiss"
          onClick={handleDismiss}
          className="ml-2 flex-shrink-0 rounded px-1 text-amber-900/70 hover:bg-amber-200/60 hover:text-amber-900 dark:text-amber-100/70 dark:hover:bg-amber-800/40 dark:hover:text-amber-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}
