import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activeLocale, setLocale } from "@/i18n";
import { useStore } from "@/lib/store";
import type { ConfigDraft } from "./Settings";
// === wave 5-β ===
// Telemetry on the welcome-tour replay so analytics can see how
// many users re-trigger the overlay (proxy for "users wanted help
// but couldn't find it the first time").
import { logEvent } from "@/lib/telemetry";
// === end wave 5-β ===

interface Props {
  draft: ConfigDraft;
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
  /** Jump the parent Settings page to the AGI tab. Optional — the widget
   *  hides its "adjust" affordance when omitted. Wired by `Settings.tsx`
   *  via `setTab("agi")`. */
  onJumpToAGI?: () => void;
}

export function GeneralSettings({ draft, update, onJumpToAGI }: Props) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<"en" | "zh">(activeLocale());
  // Quick-access mirror of the AGI sensitivity slider. Read-only here —
  // the canonical knob lives on the AGI tab (see AGISettings) so we don't
  // duplicate write paths. Clicking "adjust" jumps to the AGI tab.
  const agiSensitivity = useStore((s) => s.ui.agiSensitivity);
  const agiParticipation = useStore((s) => s.ui.agiParticipation);
  // === wave 5-β ===
  const setWelcomed = useStore((s) => s.ui.setWelcomed);
  // === end wave 5-β ===

  return (
    <div className="flex max-w-xl flex-col gap-4">
      {/* AGI sensitivity quick-access. Lives at the top of General because
          it's the most-tweaked AGI knob and users shouldn't have to dig
          into the AGI sub-tab to glance at the current value. The full
          slider stays on the AGI tab — clicking "adjust" jumps there. */}
      {/* === wave 4-D i18n === */}
      <div
        data-testid="st-general-agi-sensitivity-quick"
        className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[var(--ti-ink-700)]">
            {t("settings.general.agiSensitivity")}
          </span>
          {/* Inline preview slider. Disabled — the canonical control is
              on the AGI tab. We still render the track so the user can
              see the current value at a glance. */}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={agiSensitivity}
            disabled
            aria-label="AGI sensitivity (preview)"
            className="h-1 flex-1 accent-[var(--ti-orange-500)] disabled:cursor-not-allowed disabled:opacity-70"
          />
          <span className="w-10 text-right font-mono text-xs text-[var(--ti-ink-700)]">
            {agiParticipation ? agiSensitivity : "off"}
          </span>
          {onJumpToAGI && (
            <button
              type="button"
              onClick={onJumpToAGI}
              data-testid="st-general-agi-sensitivity-adjust"
              className="text-xs text-[var(--ti-orange-700)] hover:underline"
            >
              {t("settings.general.adjust")}
            </button>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="st-meetings-repo">{t("settings.general.meetingsRepo")}</Label>
        <Input
          id="st-meetings-repo"
          value={draft.meetings_repo}
          onChange={(e) => update("meetings_repo", e.target.value)}
          placeholder="C:\\Users\\you\\tangerine-meetings"
          data-testid="st-meetings-repo"
        />
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("settings.general.meetingsRepoHint")}
        </p>
      </div>

      <div>
        <Label htmlFor="st-log-level">{t("settings.general.logLevel")}</Label>
        <select
          id="st-log-level"
          value={draft.log_level}
          onChange={(e) => update("log_level", e.target.value)}
          data-testid="st-log-level"
          className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
      </div>

      {/* Wave 3 — Language toggle (OBSERVABILITY_SPEC §6) */}
      <div>
        <Label htmlFor="st-language">{t("settings.language.label")}</Label>
        <select
          id="st-language"
          value={lang}
          onChange={async (e) => {
            const next = e.target.value === "zh" ? "zh" : "en";
            setLang(next);
            await setLocale(next);
          }}
          data-testid="st-language"
          aria-label={t("settings.language.label")}
          className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value="en">{t("settings.language.english")}</option>
          <option value="zh">{t("settings.language.chinese")}</option>
        </select>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("settings.language.subtitle")}
        </p>
      </div>

      <div>
        <Label htmlFor="st-tz">{t("settings.general.defaultTimezone")}</Label>
        <Input id="st-tz" value="Asia/Shanghai" disabled />
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("settings.general.tzHint")}
        </p>
      </div>

      {/* === wave 5-β === */}
      {/* === wave 6 === BUG #7 — wrapped in i18n. */}
      {/* Replay welcome tour. Flips `welcomed` back to false so the
          WelcomeOverlay re-mounts on the next render. Mirrors the
          `Run welcome tour` palette command — both call setWelcomed(false).
          Wave 5-α may relocate this control during integration; the
          implementation surface (the click handler) stays here. */}
      <div data-testid="st-tour-replay-row">
        <Label htmlFor="st-tour-replay">{t("welcome.tourLabel")}</Label>
        <button
          id="st-tour-replay"
          type="button"
          data-testid="st-tour-replay"
          onClick={() => {
            void logEvent("tour_replay", { source: "settings" });
            setWelcomed(false);
          }}
          className="mt-1 rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-1.5 text-sm text-[var(--ti-ink-700)] hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          {t("welcome.tourReplay")}
        </button>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("welcome.tourReplayHint")}
        </p>
      </div>
      {/* === end wave 5-β === */}

      {/* === wave 10 === — git auto-sync settings. */}
      <GitSyncSettingsBlock />
      {/* === end wave 10 === */}
    </div>
  );
}

// === wave 10 ===
function GitSyncSettingsBlock() {
  const { t } = useTranslation();
  const gitAutoPullIntervalMin = useStore((s) => s.ui.gitAutoPullIntervalMin);
  const setGitAutoPullIntervalMin = useStore(
    (s) => s.ui.setGitAutoPullIntervalMin,
  );
  const gitAutoCommitOnHeartbeat = useStore(
    (s) => s.ui.gitAutoCommitOnHeartbeat,
  );
  const setGitAutoCommitOnHeartbeat = useStore(
    (s) => s.ui.setGitAutoCommitOnHeartbeat,
  );
  const gitAutoPushOnCommit = useStore((s) => s.ui.gitAutoPushOnCommit);
  const setGitAutoPushOnCommit = useStore((s) => s.ui.setGitAutoPushOnCommit);
  const setGitMode = useStore((s) => s.ui.setGitMode);

  return (
    <div
      data-testid="st-git-sync-block"
      className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-3"
    >
      <div className="mb-2 text-[12px] font-semibold text-[var(--ti-ink-700)]">
        {t("git.settingsHeader")}
      </div>

      <div className="mb-2">
        <Label htmlFor="st-git-pull-interval">
          {t("git.settingsAutoPullInterval")}
        </Label>
        <select
          id="st-git-pull-interval"
          data-testid="st-git-pull-interval"
          value={gitAutoPullIntervalMin}
          onChange={(e) =>
            setGitAutoPullIntervalMin(parseInt(e.target.value, 10) || 15)
          }
          className="mt-1 h-9 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value={5}>5</option>
          <option value={15}>15</option>
          <option value={30}>30</option>
        </select>
      </div>

      <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--ti-ink-700)]">
        <input
          type="checkbox"
          data-testid="st-git-auto-commit"
          checked={gitAutoCommitOnHeartbeat}
          onChange={(e) => setGitAutoCommitOnHeartbeat(e.target.checked)}
        />
        {t("git.settingsAutoCommit")}
      </label>

      <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--ti-ink-700)]">
        <input
          type="checkbox"
          data-testid="st-git-auto-push"
          checked={gitAutoPushOnCommit}
          onChange={(e) => setGitAutoPushOnCommit(e.target.checked)}
        />
        {t("git.settingsAutoPush")}
      </label>

      <button
        type="button"
        data-testid="st-git-reset-state"
        onClick={() => {
          // Re-prompts the GitInitBanner on next mount.
          setGitMode("unknown");
        }}
        className="mt-3 rounded-md border border-rose-300 px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        {t("git.settingsResetState")}
      </button>
      <p className="mt-1 text-[11px] text-[var(--ti-ink-500)]">
        {t("git.settingsResetWarning")}
      </p>
    </div>
  );
}
// === end wave 10 ===
