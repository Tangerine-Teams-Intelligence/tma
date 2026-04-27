/**
 * v2.0-beta.3 — Settings → AGI tab (simplified).
 *
 * Two user-visible knobs (down from 8 in v1.8):
 *   1. **AGI participation** master switch — master kill, unchanged
 *      from v1.8. When off the strip + ambient layer + heartbeat all
 *      pause.
 *   2. **Sensitivity slider** 0–100 — single integer that maps to the
 *      legacy volume + confidence-threshold pair internally
 *      (`sensitivityToVolumeThreshold` in `lib/store.ts`). 50 is the
 *      sensible default (= quiet + 0.7 floor, identical to v1.8's
 *      out-of-the-box behaviour).
 *
 * Everything else from v1.8 (per-channel mutes, raw threshold slider,
 * dismiss memory, telemetry wipe, suppression list) lives behind an
 * "Advanced" disclosure so power-users keep their escape hatches without
 * the default UI showing 8 knobs.
 *
 * Migration: the store's persist `merge` step calls `deriveSensitivity`
 * to compute an initial slider position from the existing
 * `agiVolume` + `agiConfidenceThreshold` for users upgrading from v1.x.
 * That keeps the prior knob position carrying forward instead of
 * resetting to 50 on first launch.
 */

// === wave 5-α ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { sensitivityToVolumeThreshold } from "@/lib/store";
import type { AgiVolume } from "@/lib/ambient";
// v1.9.0-beta.1 P1-A — telemetry wipe button. The user can nuke every
// recorded action at any time from the bottom of the AGI Settings tab.
// Privacy: telemetry stays local-only by design; this button is the
// "right to be forgotten" affordance even though we never sync the data.
import {
  telemetryClear,
  suppressionList,
  suppressionClear,
  type SuppressionEntry,
} from "@/lib/tauri";

const CHANNEL_IDS = ["canvas", "memory", "search", "today", "settings"] as const;

export function AGISettings() {
  const { t } = useTranslation();
  const agiParticipation = useStore((s) => s.ui.agiParticipation);
  const setAgiParticipation = useStore((s) => s.ui.setAgiParticipation);
  const agiVolume = useStore((s) => s.ui.agiVolume);
  const setAgiVolume = useStore((s) => s.ui.setAgiVolume);
  const mutedChannels = useStore((s) => s.ui.mutedAgiChannels);
  const toggleChannel = useStore((s) => s.ui.toggleAgiChannelMute);
  const threshold = useStore((s) => s.ui.agiConfidenceThreshold);
  const setThreshold = useStore((s) => s.ui.setAgiConfidenceThreshold);
  // === v2.0-beta.3 settings simplify ===
  const agiSensitivity = useStore((s) => s.ui.agiSensitivity);
  const setAgiSensitivity = useStore((s) => s.ui.setAgiSensitivity);
  // Local "show advanced" toggle. Not persisted — every visit to the
  // settings page starts collapsed so the simplified surface is always
  // the entry point.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // === end v2.0-beta.3 settings simplify ===
  const dismissedSurfaces = useStore((s) => s.ui.dismissedSurfaces);
  const resetDismissed = useStore((s) => s.ui.resetDismissedSurfaces);
  const pushToast = useStore((s) => s.ui.pushToast);
  // v1.9.0-beta.1 P1-A — Clear telemetry button state. Local-only state;
  // the underlying disk wipe is irreversible so we only need the
  // pending/idle bit, not a full reducer.
  const [clearingTelemetry, setClearingTelemetry] = useState(false);
  // v1.9.0-beta.3 P3-A — suppression list state. Hydrated from
  // `suppression_list` on mount so the user sees what's currently
  // silenced + how long is left on each entry. The list re-fetches
  // after the user clicks "Clear suppression list".
  const [suppressed, setSuppressed] = useState<SuppressionEntry[]>([]);
  const [clearingSuppression, setClearingSuppression] = useState(false);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const list = await suppressionList();
        if (!cancel) setSuppressed(list);
      } catch {
        // Silent — the bridge is best-effort here. The user sees an
        // empty list which is the right shape on a fresh install.
        if (!cancel) setSuppressed([]);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function onClearTelemetry() {
    setClearingTelemetry(true);
    try {
      const removed = await telemetryClear();
      pushToast(
        "success",
        removed === 0
          ? t("settings.agi.telemetryClean")
          : removed === 1
            ? t("settings.agi.telemetryCleared_one", { count: 1 })
            : t("settings.agi.telemetryCleared_other", { count: removed }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${t("settings.agi.clearTelemetryFailed")} ${msg}`);
    } finally {
      setClearingTelemetry(false);
    }
  }

  async function onClearSuppression() {
    setClearingSuppression(true);
    try {
      await suppressionClear();
      setSuppressed([]);
      pushToast("success", t("settings.agi.suppressionCleared"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${t("settings.agi.clearSuppressionFailed")} ${msg}`);
    } finally {
      setClearingSuppression(false);
    }
  }

  // When participation is off, every fine-grained control is greyed out
  // and disabled. The toggle itself stays interactive.
  const childrenDisabled = !agiParticipation;
  const dimClass = childrenDisabled ? "opacity-50" : "";

  // Localized lookups for channels + volume help. Inline so changing the
  // language flips them on the next render without a re-mount.
  const channelLabel = (id: string): string => {
    switch (id) {
      case "canvas":
        return t("settings.agi.channelCanvas");
      case "memory":
        return t("settings.agi.channelMemory");
      case "search":
        return t("settings.agi.channelSearch");
      case "today":
        return t("settings.agi.channelToday");
      case "settings":
        return t("settings.agi.channelSettings");
      default:
        return id;
    }
  };
  const channelHelp = (id: string): string => {
    switch (id) {
      case "canvas":
        return t("settings.agi.channelCanvasHelp");
      case "memory":
        return t("settings.agi.channelMemoryHelp");
      case "search":
        return t("settings.agi.channelSearchHelp");
      case "today":
        return t("settings.agi.channelTodayHelp");
      case "settings":
        return t("settings.agi.channelSettingsHelp");
      default:
        return id;
    }
  };
  const volumeHelp = (v: AgiVolume): string => {
    if (v === "silent") return t("settings.agi.volumeSilent");
    if (v === "chatty") return t("settings.agi.volumeChatty");
    return t("settings.agi.volumeQuiet");
  };

  return (
    <div className="flex flex-col gap-8" data-testid="st-agi">
      <section
        className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-4 py-3"
        data-testid="st-agi-participation-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg">{t("settings.agi.participationTitle")}</h3>
            <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
              {t("settings.agi.participationBody")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={agiParticipation}
            aria-label="Toggle AGI participation"
            onClick={() => setAgiParticipation(!agiParticipation)}
            data-testid="st-agi-participation"
            className={
              "ml-3 mt-1 flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-fast " +
              (agiParticipation
                ? "bg-[var(--ti-orange-500)]"
                : "bg-stone-300")
            }
          >
            <span
              className={
                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-fast " +
                (agiParticipation ? "translate-x-4" : "translate-x-1")
              }
            />
          </button>
        </div>
      </section>

      {/* === v2.0-beta.3 settings simplify ===
          Single sensitivity slider replaces the v1.8 trio of volume
          radio + threshold slider + per-channel mutes. The slider's
          position maps deterministically to (volume, threshold) via
          `sensitivityToVolumeThreshold`. The user keeps the underlying
          knobs reachable through the "Advanced" disclosure below — for
          the 95% of users who want one knob, this is the only knob. */}
      <section className={dimClass} data-testid="st-agi-sensitivity-card">
        <h3 className="font-display text-lg">{t("settings.agi.sensitivityTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.sensitivityBody")}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={agiSensitivity}
            disabled={childrenDisabled}
            onChange={(e) => setAgiSensitivity(Number(e.target.value))}
            data-testid="st-agi-sensitivity"
            aria-label="Sensitivity"
            className="flex-1 accent-[var(--ti-orange-500)] disabled:cursor-not-allowed"
          />
          <span
            className="w-10 text-right font-mono text-sm text-[var(--ti-ink-700)]"
            data-testid="st-agi-sensitivity-value"
          >
            {agiSensitivity}
          </span>
        </div>
        <p
          className="mt-2 text-xs text-[var(--ti-ink-500)]"
          data-testid="st-agi-sensitivity-band"
        >
          {sensitivityBandLabel(agiSensitivity, t)}
        </p>
      </section>

      {/* "Advanced" disclosure. Lets the user reach the v1.8 fine-grained
          knobs (volume radio, raw threshold slider, channel mutes) without
          showing them by default. Telemetry / suppression / dismiss-memory
          stay outside this disclosure since they're not "more knobs", they
          are escape hatches whose discoverability matters. */}
      <section data-testid="st-agi-advanced-card">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          data-testid="st-agi-advanced-toggle"
          aria-expanded={advancedOpen}
          className="flex items-center gap-2 text-sm text-[var(--ti-ink-700)] hover:text-[var(--ti-ink-900)]"
        >
          <span aria-hidden className="font-mono text-xs">
            {advancedOpen ? "▼" : "▶"}
          </span>
          {t("settings.agi.advancedToggle")}
        </button>
        {!advancedOpen && (
          <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
            {t("settings.agi.advancedHint")}
          </p>
        )}
      </section>

      {advancedOpen && (
        <>
      {/* === end v2.0-beta.3 settings simplify === */}
      <section className={dimClass}>
        <h3 className="font-display text-lg">{t("settings.agi.volumeTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.volumeBody")}
        </p>
        <div
          className="mt-4 flex flex-col gap-2"
          role="radiogroup"
          aria-label="AGI volume"
        >
          {(["silent", "quiet", "chatty"] as const).map((v) => {
            const checked = agiVolume === v;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={childrenDisabled}
                onClick={() => setAgiVolume(v)}
                data-testid={`st-agi-volume-${v}`}
                className={
                  "flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm transition-colors duration-fast disabled:cursor-not-allowed " +
                  (checked
                    ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-ink-900)]"
                    : "border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={
                      "inline-block h-3 w-3 rounded-full border " +
                      (checked
                        ? "border-[var(--ti-orange-600)] bg-[var(--ti-orange-500)]"
                        : "border-[var(--ti-border-default)] bg-transparent")
                    }
                  />
                  <span className="font-medium capitalize">{v}</span>
                </span>
                <span className="mt-1 text-xs text-[var(--ti-ink-500)]">
                  {volumeHelp(v)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className={dimClass}>
        <h3 className="font-display text-lg">{t("settings.agi.thresholdTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.thresholdBody")}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            disabled={childrenDisabled}
            onChange={(e) => setThreshold(Number(e.target.value))}
            data-testid="st-agi-threshold"
            aria-label="Confidence floor"
            className="flex-1 accent-[var(--ti-orange-500)] disabled:cursor-not-allowed"
          />
          <span
            className="w-12 text-right font-mono text-sm text-[var(--ti-ink-700)]"
            data-testid="st-agi-threshold-value"
          >
            {threshold.toFixed(2)}
          </span>
        </div>
      </section>

      <section className={dimClass}>
        <h3 className="font-display text-lg">{t("settings.agi.channelsTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.channelsBody")}
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {CHANNEL_IDS.map((cid) => {
            const muted = mutedChannels.includes(cid);
            return (
              <li
                key={cid}
                className="flex items-center justify-between rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--ti-ink-900)]">
                    {channelLabel(cid)}
                  </div>
                  <div className="text-xs text-[var(--ti-ink-500)]">{channelHelp(cid)}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!muted}
                  aria-label={`Toggle ${channelLabel(cid)}`}
                  disabled={childrenDisabled}
                  onClick={() => toggleChannel(cid)}
                  data-testid={`st-agi-mute-${cid}`}
                  className={
                    "ml-3 flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-fast disabled:cursor-not-allowed " +
                    (muted ? "bg-stone-300" : "bg-[var(--ti-orange-500)]")
                  }
                >
                  <span
                    className={
                      "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-fast " +
                      (muted ? "translate-x-1" : "translate-x-4")
                    }
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={dimClass}>
        <h3 className="font-display text-lg">{t("settings.agi.dismissTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.dismissBody", { count: dismissedSurfaces.length })}
        </p>
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={childrenDisabled}
            onClick={resetDismissed}
            data-testid="st-agi-reset-dismissed"
          >
            {t("settings.agi.dismissReset")}
          </Button>
        </div>
      </section>
        </>
      )}
      {/* === end v2.0-beta.3 advanced disclosure close === */}

      {/* v1.9.0-beta.3 P3-A — Suppressed suggestions list.
          When the user dismisses the same template-scope pair 3 times
          inside a 30-day window, the daemon promotes it to a 30-day
          suppression. This section gives visibility into what's
          silenced + an escape hatch ("Clear suppression list") to undo
          it. NOT gated on the master AGI participation switch — even
          if the layer is paused, the user must be able to inspect /
          wipe the suppression state. */}
      <section data-testid="st-agi-suppression-card">
        <h3 className="font-display text-lg">{t("settings.agi.suppressionTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {suppressed.length === 0
            ? t("settings.agi.suppressionBodyZero")
            : suppressed.length === 1
              ? t("settings.agi.suppressionBodyOne", { count: 1 })
              : t("settings.agi.suppressionBodyOther", { count: suppressed.length })}
        </p>
        {suppressed.length > 0 && (
          <ul
            className="mt-3 flex flex-col gap-1.5"
            data-testid="st-agi-suppression-list"
          >
            {suppressed
              .filter((e) => e.suppressed_until !== null)
              .map((e) => (
                <li
                  key={e.key}
                  data-testid={`st-agi-suppression-${e.template}`}
                  className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2 text-xs text-[var(--ti-ink-700)]"
                >
                  <code className="font-mono">{e.template}</code> (scope:{" "}
                  <span className="text-[var(--ti-ink-500)]">{e.scope}</span>)
                  {" — until "}
                  <span className="text-[var(--ti-ink-500)]">
                    {formatUntil(e.suppressed_until)}
                  </span>
                </li>
              ))}
          </ul>
        )}
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClearSuppression}
            disabled={clearingSuppression || suppressed.length === 0}
            data-testid="st-agi-clear-suppression"
          >
            {clearingSuppression ? t("settings.agi.suppressionClearing") : t("settings.agi.suppressionClear")}
          </Button>
        </div>
      </section>

      {/* v1.9.0-beta.1 P1-A — Clear telemetry button. Sits at the bottom
          per the spec: it's the most destructive action on this page so
          it lives below the gentler "reset dismiss memory" knob. NOT
          gated on the master AGI participation switch — the user must
          always be able to wipe their data, even if the AGI layer is
          paused. */}
      <section data-testid="st-agi-telemetry-card">
        <h3 className="font-display text-lg">{t("settings.agi.telemetryTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.agi.telemetryBody")}
        </p>
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClearTelemetry}
            disabled={clearingTelemetry}
            data-testid="st-agi-clear-telemetry"
          >
            {clearingTelemetry ? t("settings.agi.telemetryClearing") : t("settings.agi.telemetryClear")}
          </Button>
        </div>
      </section>
    </div>
  );
}

// === v2.0-beta.3 settings simplify ===
/**
 * Human-readable label for the sensitivity slider's current bucket.
 * Mirrors `sensitivityToVolumeThreshold` in `lib/store.ts`. Wave 5-α
 * routes the copy through i18n so the band label matches the active
 * locale.
 */
function sensitivityBandLabel(
  n: number,
  t: (key: string) => string,
): string {
  const { volume, threshold } = sensitivityToVolumeThreshold(n);
  if (volume === "silent") return t("settings.agi.bandSilent");
  if (volume === "chatty") return t("settings.agi.bandChatty");
  // volume === "quiet"
  if (threshold >= 0.85) return t("settings.agi.bandAlerts");
  return t("settings.agi.bandQuiet");
}
// === end v2.0-beta.3 settings simplify ===
// === end wave 5-α ===

/**
 * Render an ISO 8601 `suppressed_until` as a short human-readable
 * absolute date (`Apr 26, 2026`). The list shows lots of these in a
 * row so we keep it terse. `null` → "—".
 */
function formatUntil(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
