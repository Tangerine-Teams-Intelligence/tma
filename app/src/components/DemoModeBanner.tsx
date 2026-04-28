// === wave 13 ===
/**
 * Wave 13 — populated-app demo mode banner.
 *
 * The CEO's framing: a fresh user installs the app, opens it, sees
 * "0 ATOMS TODAY" / "Nothing captured yet" / empty graph, and bounces
 * because they assume it's broken. Wave 13 fixes this by pre-populating
 * the memory dir with a rich sample team dataset on truly-fresh first
 * launch (see `commands::demo_seed`), then surfacing this banner across
 * every route so the user knows the data they're looking at is sample
 * content — not a glitch in their own team's data.
 *
 * Behaviour:
 *   - Renders only when `store.ui.demoMode === true`.
 *   - Two CTAs:
 *       * "Connect your real team" → opens the SetupWizard (routes the
 *         user to the existing onboarding flow). The GitInitBanner is
 *         the right next surface in solo mode; the SetupWizard handles
 *         the LLM channel piece. We open the wizard because that's the
 *         single path users have already been guided down post-Welcome.
 *       * "Hide" → flips `demoMode = false`. Sample data stays on disk
 *         so the user can keep playing with it; the banner just stops
 *         interrupting them.
 *   - `aria-live="polite"` so screen readers announce the demo state.
 *
 * Standalone — props-driven where possible. Wave 12 owns the locale keys
 * (`demo.bannerTitle` / `demo.connectCta` / `demo.hideCta`); we hardcode
 * English here with `// === wave 13 wrap-needed ===` comments so Wave 12
 * can wrap them once the locale slice lands. The outer mount in AppShell
 * sits between ConnectionBanner and WhatsNewBanner — see AppShell.tsx for
 * the strip ordering rationale.
 *
 * Defensive (post-Wave-10.1 lesson): wrapped by an ErrorBoundary in
 * AppShell so a thrown render here can never blank the shell.
 */

import { useState } from "react";
import { Trash2, X } from "lucide-react";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
// === v1.13.9 round-9 ===
// R9 deceptive-success audit: the banner used to ship two CTAs only
// (Connect / Hide). "Hide" leaves seed atoms on disk — they keep
// rendering as real-looking decisions on /memory + /co-thinker. We add
// a third "Clear samples" CTA that calls `demoSeedClear` on the Rust
// side and broadcasts MEMORY_REFRESHED_EVENT so the tree re-reads.
import { demoSeedClear } from "@/lib/tauri";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
// === end v1.13.9 round-9 ===

interface DemoModeBannerProps {
  /** Optional override for "Connect" — defaults to opening the SetupWizard
   *  via the store. Passing a custom handler lets the AppShell wire to a
   *  different surface (e.g. GitInitBanner expand) once Wave 14 lands. */
  onConnect?: () => void;
  /** Optional override for "Hide" — defaults to flipping `demoMode`
   *  off and emitting a telemetry event. */
  onHide?: () => void;
  // === v1.13.9 round-9 ===
  /** Optional override for "Clear samples" — defaults to calling
   *  `demoSeedClear`, flipping `demoMode = false`, and broadcasting
   *  MEMORY_REFRESHED_EVENT. Passing a handler lets tests stub the
   *  filesystem call. */
  onClear?: () => Promise<void> | void;
  // === end v1.13.9 round-9 ===
}

export function DemoModeBanner({
  onConnect,
  onHide,
  // === v1.13.9 round-9 ===
  onClear,
  // === end v1.13.9 round-9 ===
}: DemoModeBannerProps = {}) {
  const demoMode = useStore((s) => s.ui.demoMode);
  const setDemoMode = useStore((s) => s.ui.setDemoMode);
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  // === v1.13.9 round-9 ===
  const [clearing, setClearing] = useState(false);
  // === end v1.13.9 round-9 ===

  if (!demoMode) return null;

  const handleConnect = () => {
    void logEvent("demo_banner_connect_clicked", {});
    if (onConnect) {
      onConnect();
      return;
    }
    // Default — open the SetupWizard so the user lands in the onboarding
    // flow they already know how to navigate.
    setSetupWizardOpen(true);
  };

  const handleHide = () => {
    void logEvent("demo_banner_hidden", {});
    if (onHide) {
      onHide();
      return;
    }
    setDemoMode(false);
  };

  // === v1.13.9 round-9 ===
  // Clear handler — calls the Rust `demo_seed_clear` (idempotent, only
  // touches files carrying `sample: true` in frontmatter), then flips
  // `demoMode` off so the banner self-dismisses. Best-effort: a clear
  // failure still hides the banner so the user isn't stuck — they can
  // re-trigger via Settings → Advanced if needed.
  const handleClear = async () => {
    if (clearing) return;
    setClearing(true);
    void logEvent("demo_banner_clear_clicked", {});
    try {
      if (onClear) {
        await onClear();
      } else {
        await demoSeedClear();
      }
      setDemoMode(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[v1.13.9 round-9] demo_seed_clear failed:", e);
      // Still hide the banner — the user has signaled intent.
      setDemoMode(false);
    } finally {
      setClearing(false);
    }
  };
  // === end v1.13.9 round-9 ===

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="demo-mode-banner"
      data-state="visible"
      className="ti-no-select flex items-center gap-3 border-b border-l-4 border-stone-200 border-l-[var(--ti-orange-500)] bg-[var(--ti-paper-50,#FAFAF7)] px-4 py-2 text-[12px] text-stone-800 dark:border-stone-700 dark:border-l-[var(--ti-orange-500)] dark:bg-stone-900 dark:text-stone-200"
    >
      <span aria-hidden className="text-[14px]">
        {/* Tangerine emoji prefix — matches v1.9 suggestion-toast convention. */}
        🍊
      </span>
      <span className="flex-1">
        {/* === wave 13 wrap-needed === — Wave 12 owns `demo.bannerTitle`. */}
        <strong className="font-semibold">Showing sample team data.</strong>{" "}
        Browse around to see what a populated Tangerine looks like.
      </span>
      <button
        type="button"
        onClick={handleConnect}
        data-testid="demo-mode-banner-connect"
        className="rounded border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-100,#FFE4CD)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-200,#FFD0A8)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-700"
      >
        {/* === wave 13 wrap-needed === — Wave 12 owns `demo.connectCta`. */}
        Connect your real team
      </button>
      {/* === v1.13.9 round-9 ===
          R9 deceptive-success audit: explicit "delete the seed atoms"
          path. Without this the only options were Connect (wires real
          data alongside the seed — pollution stays) or Hide (banner
          gone, fake decisions still render on /memory + /co-thinker as
          if real). */}
      <button
        type="button"
        onClick={() => void handleClear()}
        disabled={clearing}
        data-testid="demo-mode-banner-clear"
        aria-label="Clear sample data"
        title="Delete the bundled sample atoms — your own data stays."
        className="flex items-center gap-1 rounded border border-stone-200 bg-white px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        <Trash2 size={11} aria-hidden />
        {clearing ? "Clearing…" : "Clear samples"}
      </button>
      {/* === end v1.13.9 round-9 === */}
      <button
        type="button"
        onClick={handleHide}
        data-testid="demo-mode-banner-hide"
        aria-label="Hide demo banner"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
      >
        {/* === wave 13 wrap-needed === — Wave 12 owns `demo.hideCta`. */}
        <X size={11} aria-hidden />
        Hide
      </button>
    </div>
  );
}

export default DemoModeBanner;
// === end wave 13 ===
