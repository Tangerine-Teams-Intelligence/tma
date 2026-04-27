/**
 * v1.9.0-beta.1 — Suggestion bus.
 *
 * Single dispatcher for `pushSuggestion(req)`. Decides the tier via
 * `selectTier()` and forwards the request to the right rendering
 * surface (chip / banner / toast / modal). This is the choke-point
 * where the 6 anti-Clippy disciplines are enforced *across* tiers, so
 * the off-switch + confidence floor + dismiss memory + max-1-active
 * cannot be bypassed by going around a tier component directly.
 *
 * Disciplines (per SUGGESTION_ENGINE_SPEC.md §1):
 *   1. Max 1 active suggestion per tier — banner/modal queues enforce
 *      single-visible; chip path delegates to `AmbientInputObserver`
 *      whose existing MAX_VISIBLE policy stays in force.
 *   2. Confidence floor — re-checked here against the ambient
 *      `MIN_CONFIDENCE` floor + the user-tunable
 *      `agiConfidenceThreshold`. The higher of the two wins.
 *   3. Dismiss × 3 → 30d suppression — TODO in v1.9.0-beta.3 per the
 *      phasing in the spec. Today we honour the 24h dismiss memory.
 *   4. 4 visual tiers — covered by `selectTier`.
 *   5. Rule-based < 10ms — bus is sync-ish; only the chip path awaits
 *      the AmbientCtx hook. We don't block on telemetry (fire-and-forget).
 *   6. Off switch — `agiParticipation === false` short-circuits before
 *      any rendering happens.
 *
 * Telemetry: P1-A is wiring `logEvent("suggestion_pushed", …)` in a
 * separate file. We import it lazily — if the module isn't there yet
 * we no-op so the bus stays decoupled. Once P1-A lands every
 * `pushSuggestion` will log a row.
 */

import { useStore } from "./store";
import {
  selectTier,
  type SuggestionRequest,
  type SuggestionTier,
} from "./suggestion-tier";
import { MIN_CONFIDENCE } from "./ambient";
import type { BannerProps } from "@/components/suggestions/Banner";
import type { ModalProps } from "@/components/suggestions/Modal";

/**
 * Optional chip-tier sink. The `<AmbientInputObserver/>` mounts at the
 * AppShell level and exposes a context with `showReaction(...)`. We keep
 * a lazy reference here so the bus can route chip suggestions without
 * forcing a React parent (tests + non-React callers).
 *
 * `connectChipSink(ctx)` is wired by an effect inside the observer; if
 * no observer is mounted, chip suggestions silently fall back to a toast.
 */
type ChipSink = (
  surfaceId: string,
  text: string,
  confidence: number,
) => void;

let chipSink: ChipSink | null = null;

export function connectChipSink(sink: ChipSink | null): void {
  chipSink = sink;
}

/**
 * Re-export the tier type so callers can declare typed handlers without
 * pulling from two modules.
 */
export type { SuggestionRequest, SuggestionTier };

/**
 * Telemetry seam.
 *
 * Default backend is the real `lib/telemetry.ts::logEvent` from P1-A;
 * that ships a fire-and-forget Tauri call with a 90-day local JSONL
 * archive (see SUGGESTION_ENGINE_SPEC.md §2). Tests can swap in a mock
 * via `connectTelemetry(fn)` to assert what events fired without
 * spinning up the IPC bridge.
 *
 * Hard contract: telemetry MUST be fire-and-forget. We `void` the
 * promise here so a stalled Tauri round trip never blocks suggestion
 * rendering.
 */
import { logEvent as p1aLogEvent } from "./telemetry";

type TelemetryFn = (event: string, payload: Record<string, unknown>) => void;
let telemetry: TelemetryFn = (event, payload) => {
  void p1aLogEvent(event as never, payload);
};

export function connectTelemetry(fn: TelemetryFn | null): void {
  telemetry =
    fn ??
    ((event, payload) => {
      void p1aLogEvent(event as never, payload);
    });
}

function safeLogEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  try {
    telemetry(event, payload);
  } catch {
    // No-op — telemetry must never break the suggestion render path.
  }
}

/**
 * Compute the effective confidence floor from store state. Mirrors the
 * `shouldShowReaction` policy in `lib/ambient.ts` so a bus consumer is
 * gated identically to the chip pipeline.
 */
function effectiveConfidenceFloor(): number {
  const s = useStore.getState().ui;
  const userBar = s.agiConfidenceThreshold ?? MIN_CONFIDENCE;
  return Math.max(userBar, MIN_CONFIDENCE);
}

/**
 * Build a `BannerProps` payload from a `SuggestionRequest`. The bus
 * supplies the dismiss handler so `<BannerHost/>` sees the right entry
 * pop off the queue. Callers may still set their own `onDismiss` for
 * side effects — we wrap it.
 */
function toBannerProps(
  req: SuggestionRequest,
): BannerProps {
  const id = `${req.template}:${cryptoRandomId()}`;
  return {
    id,
    body: req.body,
    ctaLabel: req.ctaLabel,
    ctaHref: req.ctaHref,
    onAccept: req.onAccept,
    priority: req.priority ?? 5,
    dismissable: true,
  };
}

function toModalProps(
  req: SuggestionRequest,
): ModalProps {
  const id = `${req.template}:${cryptoRandomId()}`;
  return {
    id,
    title: req.title ?? "Confirm action",
    body: req.body,
    confirmLabel: req.confirmLabel ?? req.ctaLabel ?? "Confirm",
    cancelLabel: req.cancelLabel ?? "Cancel",
    dangerous: req.dangerous,
    // The host wraps these with queue pop logic; the request's onAccept
    // is the user's "they confirmed" callback.
    onConfirm: req.onAccept ?? (() => {}),
    onCancel: () => {},
  };
}

/**
 * The single entry point. Async because the chip path may need to await
 * the `<AmbientInputObserver/>` ctx in some test setups. Resolve order:
 *
 *   1. Off-switch / confidence floor → drop silently.
 *   2. `selectTier(req)` → tier.
 *   3. Modal budget: ≤ 1 per session per spec §3.4. A second modal
 *      demotes to a banner with the same body.
 *   4. Push to the right surface.
 *   5. Fire telemetry.
 *
 * Returns void on every path so callers don't have to handle a
 * structured drop reason — telemetry surfaces the diagnostics.
 */
export async function pushSuggestion(req: SuggestionRequest): Promise<void> {
  const ui = useStore.getState().ui;

  // Discipline 6 — master kill switch.
  if (ui.agiParticipation === false) {
    safeLogEvent("suggestion_dropped", {
      template: req.template,
      reason: "agi_participation_off",
    });
    return;
  }

  // Discipline 2 — confidence floor.
  const floor = effectiveConfidenceFloor();
  if (req.confidence < floor) {
    safeLogEvent("suggestion_dropped", {
      template: req.template,
      reason: "below_confidence_floor",
      confidence: req.confidence,
      floor,
    });
    return;
  }

  let tier: SuggestionTier = selectTier(req);

  // Modal budget per spec §3.4: max 1 modal per session. A second modal
  // in the same session demotes itself to a banner with the same body.
  if (tier === "modal" && ui.modalsShownThisSession >= 1) {
    tier = "banner";
  }

  safeLogEvent("suggestion_pushed", {
    template: req.template,
    tier,
    confidence: req.confidence,
  });

  switch (tier) {
    case "chip": {
      if (req.surface_id && chipSink) {
        chipSink(req.surface_id, req.body, req.confidence);
      } else {
        // No observer mounted (or missing surface_id) — degrade to a
        // toast so the suggestion still surfaces. This mirrors the
        // "always render somewhere" contract: dropped suggestions only
        // happen for the disciplines, never for plumbing reasons.
        ui.pushToast({
          kind: "suggestion",
          msg: req.body,
          template: req.template,
          ctaLabel: req.ctaLabel,
          ctaHref: req.ctaHref,
          onAccept: req.onAccept,
        });
      }
      return;
    }
    case "banner": {
      ui.pushBanner(toBannerProps(req));
      return;
    }
    case "toast": {
      ui.pushToast({
        kind: "suggestion",
        msg: req.body,
        template: req.template,
        ctaLabel: req.ctaLabel,
        ctaHref: req.ctaHref,
        onAccept: req.onAccept,
      });
      return;
    }
    case "modal": {
      ui.pushModal(toModalProps(req));
      return;
    }
  }
}

/** Lightweight cryptoRandomId mirror — keeps this module independent of
 *  the store's private helper. Not security-sensitive. */
function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

