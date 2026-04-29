// === v1.15.0 Wave 1.4 ===
/**
 * v1.15.0 Wave 1.4 — Solo Cloud upgrade prompt.
 *
 * Non-blocking global banner that surfaces a paid-tier upsell once the
 * solo user has either:
 *   1. Spent ≥ 7 days post-onboarding inside the app, OR
 *   2. Captured ≥ 50 atoms (whichever comes first).
 *
 * Whichever trigger fires first wins. The banner is dismissable; once
 * dismissed it sleeps for 7 days before becoming eligible again. Mounts
 * as a non-blocking strip in `AppShell` (NOT a modal) — the user's
 * current view stays interactive while the banner sits above it.
 *
 * Telemetry:
 *   - `solo_cloud_upgrade_prompt_shown` fires the first render after
 *     the eligibility check passes (per session, deduped via the
 *     ref-latch below so a re-render doesn't double-fire).
 *   - `solo_cloud_upgrade_clicked` fires on the Upgrade CTA.
 *
 * The Upgrade CTA opens an external Stripe Checkout URL via
 * `tauri-plugin-shell` (the same `openExternal` wrapper the rest of the
 * app uses for billing / docs / OAuth). The URL is read from
 * `import.meta.env.VITE_STRIPE_SOLO_CHECKOUT_URL`; falls back to a
 * placeholder so the build doesn't fail when the env var is unset
 * locally.
 *
 * Defensive: wrapped by an ErrorBoundary in AppShell so a render
 * throw can never blank the shell (Wave 10.1 lesson). Self-hides when
 * the user is in team mode (`onboardingScope === "team"`) — the team
 * billing pitch is a separate surface (Wave 1.4 spec §3).
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { openExternal } from "@/lib/tauri";

/** 7 days in ms — both the initial-trigger threshold and the
 *  post-dismissal cool-down. Centralised so the test can reuse it. */
export const SOLO_CLOUD_PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Atom-count threshold — fires the prompt the first time the user's
 *  memory dir crosses 50 atoms even when they're under 7 days old. */
export const SOLO_CLOUD_PROMPT_ATOM_THRESHOLD = 50;

/** v1.15.1 fix — Stripe checkout is not yet wired (no real product +
 *  price + webhook configured), so the legacy "fall back to a 404
 *  placeholder URL" behavior was an R6/R7/R8 violation: clicking
 *  Upgrade promised a checkout and broke trust by 404'ing. The fix:
 *  resolveCheckoutUrl returns `null` when the build-time env var is
 *  absent, and the component renders a "Coming soon" disabled CTA
 *  instead of a clickable button. The banner still shows so we still
 *  measure intent (`solo_cloud_upgrade_prompt_shown`), but we never
 *  paint a clickable button we cannot honor. */
export const SOLO_CLOUD_FALLBACK_URL: string | null = null;

/** Read the configured Stripe URL from Vite env. Returns `null` when
 *  unset so the component can decide between a real button and the
 *  "Coming soon" placeholder. Centralised so tests can monkey-patch. */
function resolveCheckoutUrl(): string | null {
  // Vite injects `import.meta.env.*` at build time. The cast through
  // `unknown` keeps strict TS happy when the key is absent.
  const env = (import.meta as unknown as {
    env?: { VITE_STRIPE_SOLO_CHECKOUT_URL?: string };
  }).env;
  const u = env?.VITE_STRIPE_SOLO_CHECKOUT_URL;
  if (typeof u === "string" && u.length > 0) return u;
  return SOLO_CLOUD_FALLBACK_URL;
}

/**
 * Pure eligibility check — extracted so the vitest spec can drive it
 * without mounting React. Fires when EITHER:
 *   - At least `SOLO_CLOUD_PROMPT_COOLDOWN_MS` has elapsed since
 *     `onboardingCompletedAt`, OR
 *   - The user has captured ≥ `SOLO_CLOUD_PROMPT_ATOM_THRESHOLD` atoms.
 *
 * Suppressed when:
 *   - `onboardingCompletedAt` is null (user hasn't onboarded yet — never
 *     pitch billing pre-onboarding).
 *   - `dismissedAt` is within the last `SOLO_CLOUD_PROMPT_COOLDOWN_MS`.
 *   - The user is in team mode (the team upsell is a different banner).
 */
export function shouldShowSoloCloudPrompt(args: {
  now: number;
  onboardingCompletedAt: number | null;
  dismissedAt: number | null;
  atomCount: number;
  scope: "solo" | "team" | null;
}): boolean {
  const { now, onboardingCompletedAt, dismissedAt, atomCount, scope } = args;
  // Hard suppression: team users see the team-cloud pitch elsewhere.
  if (scope === "team") return false;
  // Pre-onboarding users never see billing.
  if (onboardingCompletedAt === null) return false;
  // Recent dismissal cool-down.
  if (
    dismissedAt !== null &&
    now - dismissedAt < SOLO_CLOUD_PROMPT_COOLDOWN_MS
  ) {
    return false;
  }
  // Either trigger satisfies the OR.
  const sevenDaysElapsed =
    now - onboardingCompletedAt >= SOLO_CLOUD_PROMPT_COOLDOWN_MS;
  const atomThresholdHit = atomCount >= SOLO_CLOUD_PROMPT_ATOM_THRESHOLD;
  return sevenDaysElapsed || atomThresholdHit;
}

interface SoloCloudUpgradePromptProps {
  /** Atom count from the upstream `listAtoms` hook. Wired in AppShell.
   *  Keeping it a prop (not an internal listAtoms call) so the global
   *  banner doesn't pay the IPC round-trip on every render and tests
   *  can drive the threshold deterministically. */
  atomCount: number;
  /** Optional override — defaults to `Date.now()`. Tests inject a
   *  fixed clock to drive the eligibility branches deterministically. */
  now?: number;
  /** Optional override for `openExternal` — tests inject a spy so the
   *  Tauri bridge isn't required at unit-test time. */
  onUpgrade?: () => void | Promise<void>;
}

export function SoloCloudUpgradePrompt({
  atomCount,
  now,
  onUpgrade,
}: SoloCloudUpgradePromptProps) {
  const onboardingCompletedAt = useStore((s) => s.ui.onboardingCompletedAt);
  const dismissedAt = useStore((s) => s.ui.soloCloudPromptDismissedAt);
  const setDismissedAt = useStore((s) => s.ui.setSoloCloudPromptDismissedAt);
  const scope = useStore((s) => s.ui.onboardingScope);

  const shouldShow = shouldShowSoloCloudPrompt({
    now: now ?? Date.now(),
    onboardingCompletedAt,
    dismissedAt,
    atomCount,
    scope,
  });

  // Per-mount latch so a parent re-render doesn't re-fire the
  // `_shown` event. The store-backed dismiss timestamp handles
  // session-to-session deduping; this just guards within a session.
  const shownEmitted = useRef(false);

  useEffect(() => {
    if (shouldShow && !shownEmitted.current) {
      shownEmitted.current = true;
      void logEvent("solo_cloud_upgrade_prompt_shown", {});
    }
  }, [shouldShow]);

  if (!shouldShow) return null;

  // v1.15.1 fix — resolve checkout URL once. `null` means Stripe isn't
  // wired yet → render the "Coming soon" disabled CTA below instead of
  // a clickable button that 404s. R6/R7/R8 honesty: never paint a
  // button we cannot honor.
  const checkoutUrl = resolveCheckoutUrl();

  const handleUpgrade = async () => {
    void logEvent("solo_cloud_upgrade_clicked", {});
    if (onUpgrade) {
      await onUpgrade();
      return;
    }
    if (checkoutUrl === null) return; // Disabled state — should be unreachable.
    try {
      await openExternal(checkoutUrl);
    } catch {
      // openExternal already swallows + console.errors; this catch is
      // belt-and-suspenders so the click handler never throws into
      // React.
    }
  };

  const handleDismiss = () => {
    setDismissedAt(Date.now());
    // Wave 4 wire-up — emit dismiss telemetry so analytics can compute
    // dismiss-rate vs upgrade-rate and detect "users keep dismissing".
    // The 7d cool-down is enforced by the store flag separately.
    void logEvent("solo_cloud_upgrade_dismissed", {
      snooze_days: 7,
    });
  };

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="Solo Cloud upgrade prompt"
      data-testid="solo-cloud-upgrade-prompt"
      className="ti-no-select flex h-9 items-center justify-center gap-3 border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 text-[12px] font-medium text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]"
    >
      <span>
        Sync your memory across machines with Solo Cloud — encrypted, private,
        always available.
      </span>
      {checkoutUrl !== null ? (
        <button
          type="button"
          onClick={() => void handleUpgrade()}
          data-testid="solo-cloud-upgrade-cta"
          className="rounded bg-[var(--ti-orange-500)] px-2 py-0.5 text-white hover:bg-[var(--ti-orange-600)]"
        >
          Upgrade $10/mo
        </button>
      ) : (
        // v1.15.1 — Stripe not wired; honest disabled state instead of
        // a 404'ing button. The banner still measures intent via the
        // `_shown` event so we know how many users would have clicked.
        <span
          data-testid="solo-cloud-upgrade-cta-coming-soon"
          aria-disabled="true"
          title="Solo Cloud sync is rolling out — set VITE_STRIPE_SOLO_CHECKOUT_URL to enable."
          className="cursor-not-allowed rounded bg-stone-300 px-2 py-0.5 text-stone-700 dark:bg-stone-700 dark:text-stone-300"
        >
          Coming soon
        </span>
      )}
      <button
        type="button"
        aria-label="Dismiss Solo Cloud upgrade prompt"
        onClick={handleDismiss}
        data-testid="solo-cloud-upgrade-dismiss"
        className="opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
// === end v1.15.0 Wave 1.4 ===
