/**
 * v1.8 Phase 4 — Settings → AGI tab.
 *
 * Top of the page: **AGI participation** master switch (v1.8). Hard kill
 * for the frontend ambient layer — when off, no inline reactions, no
 * heartbeat, no system tray. Volume / channel / threshold controls below
 * remain visible but disabled (greyed out) so the user sees what would
 * resume if they flip it back on.
 *
 * The user's three fine-grained knobs over how loud the ambient AGI is
 * allowed to be (only meaningful when participation === true):
 *   1. Volume band — silent / quiet / chatty.
 *   2. Confidence floor — 0.50–0.95 slider, clamped on top of the
 *      hard-coded MIN_CONFIDENCE in `lib/ambient.ts`.
 *   3. Per-channel mutes — Canvas / Memory edits / Cmd+K / /today /
 *      Settings. Listed as toggles so each surface can be silenced
 *      independently.
 *
 * Plus a "Reset dismiss memory" button that clears the 24h dismiss list.
 * Useful when the user wants to start fresh without waiting for the
 * window to expire.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
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

const CHANNELS: { id: string; label: string; help: string }[] = [
  { id: "canvas", label: "Canvas", help: "Freeform note + scratchpad surface." },
  { id: "memory", label: "Memory edit", help: "Editing a /memory/* atom." },
  { id: "search", label: "Cmd+K palette", help: "The global Cmd+K search bar." },
  { id: "today", label: "/today", help: "Today's timeline + brief composer." },
  { id: "settings", label: "Settings", help: "Forms inside Settings itself." },
];

const VOLUME_HELP: Record<AgiVolume, string> = {
  silent:
    "No inline reactions ever. AGI still runs in the co-thinker brain " +
    "and tray, just not in the margin.",
  quiet:
    "Default. High-confidence reactions only (≥ your confidence floor + " +
    "the volume floor). Most input events stay silent.",
  chatty:
    "Lower bar. Surfaces lower-confidence hunches too. Useful when you " +
    "actively want the AGI to push back more often.",
};

export function AGISettings() {
  const agiParticipation = useStore((s) => s.ui.agiParticipation);
  const setAgiParticipation = useStore((s) => s.ui.setAgiParticipation);
  const agiVolume = useStore((s) => s.ui.agiVolume);
  const setAgiVolume = useStore((s) => s.ui.setAgiVolume);
  const mutedChannels = useStore((s) => s.ui.mutedAgiChannels);
  const toggleChannel = useStore((s) => s.ui.toggleAgiChannelMute);
  const threshold = useStore((s) => s.ui.agiConfidenceThreshold);
  const setThreshold = useStore((s) => s.ui.setAgiConfidenceThreshold);
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
          ? "Telemetry already clean — nothing to clear."
          : `Telemetry cleared (${removed} day${removed === 1 ? "" : "s"} of events removed).`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `Clear telemetry failed: ${msg}`);
    } finally {
      setClearingTelemetry(false);
    }
  }

  async function onClearSuppression() {
    setClearingSuppression(true);
    try {
      await suppressionClear();
      setSuppressed([]);
      pushToast("success", "Suppression list cleared.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `Clear suppression failed: ${msg}`);
    } finally {
      setClearingSuppression(false);
    }
  }

  // When participation is off, every fine-grained control is greyed out
  // and disabled. The toggle itself stays interactive.
  const childrenDisabled = !agiParticipation;
  const dimClass = childrenDisabled ? "opacity-50" : "";

  return (
    <div className="flex flex-col gap-8" data-testid="st-agi">
      <section
        className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-4 py-3"
        data-testid="st-agi-participation-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg">AGI participation</h3>
            <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
              Master switch. When off, no inline reactions, no heartbeat,
              no system tray. Tangerine&apos;s AI brain pauses.
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

      <section className={dimClass}>
        <h3 className="font-display text-lg">AGI volume</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          The whole app is a chat surface. Tangerine's AGI may surface a
          tiny inline reaction — a 🍊 dot in the page margin — when you
          type into any input. Volume controls how often.
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
                  {VOLUME_HELP[v]}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className={dimClass}>
        <h3 className="font-display text-lg">Confidence floor</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Reactions below this confidence never surface, regardless of
          volume. Default 0.70.
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
        <h3 className="font-display text-lg">Channel mutes</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Disable ambient reactions on individual surfaces without
          flipping the global volume.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {CHANNELS.map((c) => {
            const muted = mutedChannels.includes(c.id);
            return (
              <li
                key={c.id}
                className="flex items-center justify-between rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--ti-ink-900)]">
                    {c.label}
                  </div>
                  <div className="text-xs text-[var(--ti-ink-500)]">{c.help}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!muted}
                  aria-label={`Toggle ${c.label}`}
                  disabled={childrenDisabled}
                  onClick={() => toggleChannel(c.id)}
                  data-testid={`st-agi-mute-${c.id}`}
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
        <h3 className="font-display text-lg">Dismiss memory</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          When you dismiss a reaction, that surface is muted for 24h.
          Currently {dismissedSurfaces.length} surface
          {dismissedSurfaces.length === 1 ? "" : "s"} silenced.
        </p>
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={childrenDisabled}
            onClick={resetDismissed}
            data-testid="st-agi-reset-dismissed"
          >
            Reset dismiss memory
          </Button>
        </div>
      </section>

      {/* v1.9.0-beta.3 P3-A — Suppressed suggestions list.
          When the user dismisses the same template-scope pair 3 times
          inside a 30-day window, the daemon promotes it to a 30-day
          suppression. This section gives visibility into what's
          silenced + an escape hatch ("Clear suppression list") to undo
          it. NOT gated on the master AGI participation switch — even
          if the layer is paused, the user must be able to inspect /
          wipe the suppression state. */}
      <section data-testid="st-agi-suppression-card">
        <h3 className="font-display text-lg">Suppressed suggestions</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Suggestions you&apos;ve dismissed 3+ times for the same atom or
          surface get silenced for 30 days. {suppressed.length === 0
            ? "Nothing is currently suppressed."
            : `${suppressed.length} ${suppressed.length === 1 ? "entry is" : "entries are"} silenced.`}
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
            {clearingSuppression ? "Clearing…" : "Clear suppression list"}
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
        <h3 className="font-display text-lg">Telemetry</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Tangerine logs every meaningful action (route changes, atom
          opens, dismisses, …) to{" "}
          <code className="font-mono text-[11px]">
            ~/.tangerine-memory/.tangerine/telemetry/
          </code>{" "}
          so the suggestion engine can detect patterns. All events stay
          local — nothing syncs to the cloud. Files older than 90 days
          are auto-pruned.
        </p>
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClearTelemetry}
            disabled={clearingTelemetry}
            data-testid="st-agi-clear-telemetry"
          >
            {clearingTelemetry ? "Clearing…" : "Clear telemetry"}
          </Button>
        </div>
      </section>
    </div>
  );
}

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
