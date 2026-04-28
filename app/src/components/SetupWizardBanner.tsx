// === wave 11 ===
/**
 * v1.10.2 — slim banner that nudges fresh installs to set up an LLM
 * channel before the heartbeat starts firing failed dispatches.
 *
 * Rendered ONLY when:
 *   - `setupWizardChannelReady === false` AND
 *   - `setupWizardDismissedThisSession === false`
 *
 * The banner is intentionally tame — one short line, two buttons. The
 * "Set up now" button opens the SetupWizard modal; "Dismiss" suppresses
 * the banner for this session only (cold launch resets it so the user
 * keeps seeing it until they actually finish, OR they hit "Skip for now"
 * inside the wizard which flips `setupWizardSkipped` to true).
 *
 * Mounted at the AppShell layer in the system-banner stack so it stays
 * visible across route changes. Independent of the WelcomeOverlay (4-C)
 * and the auto-trigger of SetupWizard on first launch — those are
 * one-shot first-run nudges; this banner is the persistent reminder
 * for users who skipped the auto-trigger.
 */

import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

export function SetupWizardBanner() {
  const { t } = useTranslation();
  const channelReady = useStore((s) => s.ui.setupWizardChannelReady);
  const dismissedThisSession = useStore(
    (s) => s.ui.setupWizardDismissedThisSession,
  );
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  const setSetupWizardDismissedThisSession = useStore(
    (s) => s.ui.setSetupWizardDismissedThisSession,
  );

  // Self-hide for happy-path users + users who explicitly dismissed
  // for this session.
  if (channelReady) return null;
  if (dismissedThisSession) return null;

  return (
    <div
      data-testid="setup-wizard-banner"
      className="ti-no-select flex flex-wrap items-center gap-3 border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 py-2 text-[12px] text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]"
    >
      <Sparkles size={14} className="shrink-0" aria-hidden />
      <span className="flex-1 leading-relaxed">{t("setupWizard.bannerText")}</span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            void logEvent("setup_wizard_banner_open", {});
            setSetupWizardOpen(true);
          }}
          data-testid="setup-wizard-banner-open"
        >
          {t("setupWizard.bannerOpen")}
        </Button>
        <button
          type="button"
          aria-label={t("setupWizard.bannerDismiss")}
          data-testid="setup-wizard-banner-dismiss"
          onClick={() => {
            void logEvent("setup_wizard_banner_dismissed", {});
            setSetupWizardDismissedThisSession(true);
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-100)] dark:hover:bg-stone-800"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// === end wave 11 ===
