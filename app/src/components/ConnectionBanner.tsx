/**
 * Wave 3 cross-cut — Network connectivity banner.
 *
 * Per OBSERVABILITY_SPEC §8 (Edge cases catalog):
 *   "Network offline → Graceful degrade. Queue writes locally, retry with
 *    exponential backoff. Visible 'offline' indicator in status bar."
 *
 * This component owns the visible offline indicator. Queueing of writes /
 * retry-with-backoff is owned by the IPC layer at `lib/tauri.ts`; this
 * banner just lights up so the user knows their actions are deferred.
 *
 * Behaviour:
 *   * On `navigator.onLine === false` at mount → render the offline banner.
 *   * Listens to `online` / `offline` window events so the banner flips in
 *     real time without a poll loop. Browser fires both reliably on Tauri's
 *     webview (Edge WebView2 / WKWebView).
 *   * `role="alert"` so screen readers announce the state change immediately
 *     (matches the §7 a11y rule that banners must be aria-live).
 *
 * Not done here (defer to feature work):
 *   * Per-source online/offline (e.g. Slack auth expired but we're online).
 *   * Action queue UI ("3 changes pending"). The queue belongs in `lib/`
 *     once a real op-queue lands.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Read-once initial online state. SSR / vitest jsdom default to `true` if
 * `navigator` is absent — that's the right default (we never want to
 * render the offline banner in tests by accident).
 */
function readInitialOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // `onLine` is `true` by default in browsers; only flips false on a
  // confirmed network drop. Rare false positives on captive portals are
  // acceptable — this is a soft hint, not a hard gate.
  return navigator.onLine !== false;
}

export function ConnectionBanner() {
  const { t } = useTranslation();
  const [online, setOnline] = useState<boolean>(readInitialOnline);
  // Track a transient "back online" state so the banner can flash a green
  // confirmation for ~2.5s before disappearing. Without this the user sees
  // the banner blink off and may not register the recovery.
  const [recentlyRestored, setRecentlyRestored] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUp = () => {
      setOnline(true);
      setRecentlyRestored(true);
      // 2.5s is short enough to feel responsive, long enough to read.
      const handle = window.setTimeout(() => setRecentlyRestored(false), 2_500);
      return () => window.clearTimeout(handle);
    };
    const onDown = () => {
      setOnline(false);
      setRecentlyRestored(false);
    };
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  if (online && !recentlyRestored) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="connection-banner"
      data-state={online ? "online" : "offline"}
      className={
        "ti-no-select flex h-7 items-center justify-center border-b px-4 text-[11px] font-medium " +
        (online
          ? "border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-stone-900 dark:text-emerald-400"
          : "border-amber-500/30 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-stone-900 dark:text-amber-400")
      }
    >
      {online ? t("errors.online") : t("errors.offline")}
    </div>
  );
}

export default ConnectionBanner;
