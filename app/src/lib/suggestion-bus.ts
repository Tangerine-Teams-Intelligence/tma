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
 *   3. Dismiss × 3 → 30d suppression — landed in v1.9.0-beta.3 P3-A
 *      via the `suppression_check` Tauri command. The bus reads the
 *      backend map keyed by `{template, scope}` (scope chain:
 *      atom_refs[0] → surface_id → "global"). Suppressed matches drop
 *      with `reason: "suppressed"`. The 24h dismiss memory in
 *      `dismissedSurfaces` continues to gate at the chip layer.
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
import { suppressionCheck as backendSuppressionCheck } from "./tauri";
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
 * Suppression-check seam — defaults to the real Tauri command from
 * `lib/tauri.ts` (which itself mocks to `false` outside Tauri so the
 * bus never silences a suggestion just because the bridge is missing).
 *
 * Tests can swap in a deterministic mock via `connectSuppressionCheck(fn)`
 * to assert which `{template, scope}` pairs were consulted without
 * spinning up the IPC bridge.
 */
type SuppressionCheckFn = (template: string, scope: string) => Promise<boolean>;

let suppressionCheckImpl: SuppressionCheckFn = backendSuppressionCheck;

export function connectSuppressionCheck(fn: SuppressionCheckFn | null): void {
  suppressionCheckImpl = fn ?? backendSuppressionCheck;
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
 * Resolve the suppression scope for a request. Mirrors the Rust-side
 * scope chain (`agi::suppression::derive_scope`):
 *
 *   1. The first non-empty entry of `atom_refs`.
 *   2. Else `surface_id` (chip-tier anchor).
 *   3. Else the literal `"global"`.
 *
 * Kept in lockstep with the backend so a recompute pass and a
 * `pushSuggestion` consult the same key for the same request.
 */
export function deriveSuppressionScope(req: SuggestionRequest): string {
  const refs = req.atom_refs;
  if (refs && refs.length > 0) {
    const first = refs[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  if (req.surface_id) return req.surface_id;
  return "global";
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

  // v1.9.0-beta.3 Polish 3 — agiVolume gate with an irreversible
  // exception.
  //
  // The chip pipeline already gates on `agiVolume === "silent"` in
  // `shouldShowReaction()` (see `lib/ambient.ts`). For the bus we mirror
  // that policy across ALL non-modal tiers — banner / toast / chip — so
  // a "silent" user never gets passive AGI surfaces.
  //
  // EXCEPTION: when the AGI is about to take an IRREVERSIBLE action
  // (`is_irreversible === true`), we MUST still show the modal. Silent
  // mode silences proactive nudges; it MUST NOT silently bypass the
  // human's hard-stop confirmation, because that would let the AGI
  // commit destructive actions (publish, write to memory, fan out a
  // Slack post) without the user ever seeing the prompt. That is a UX
  // trap (the user expects "silent" to mean "no nags", not "the AGI
  // does whatever it wants without asking").
  //
  // This matches the Phase-3 acceptance gate "off switch silences ALL
  // surfaces (modal exempt — the modal IS the safety check, not a
  // nag)".
  if (ui.agiVolume === "silent" && req.is_irreversible !== true) {
    safeLogEvent("suggestion_dropped", {
      template: req.template,
      reason: "agi_volume_silent",
    });
    return;
  }

  // Discipline 3 — dismiss × 3 → 30d suppression (v1.9.0-beta.3 P3-A).
  //
  // Consult the backend `suppression_check` Tauri command for the
  // {template, scope} pair. The daemon recomputes the suppression map
  // every heartbeat from the telemetry log; this call simply reads the
  // current state.
  //
  // Modal exception (same rationale as the volume gate above): an
  // irreversible action's confirmation modal is a hard-stop safety
  // check, not a proactive nudge. We MUST NOT silently swallow it —
  // the user must see the prompt to make a decision. Suppression
  // applies to the proactive tiers (chip / banner / toast) only.
  //
  // Best-effort: a thrown error from the bridge degrades to "not
  // suppressed" rather than silencing the suggestion. Telemetry
  // `suggestion_dropped` covers the suppressed path so analytics can
  // still see the drop reason.
  if (req.is_irreversible !== true) {
    const scope = deriveSuppressionScope(req);
    let suppressed = false;
    try {
      suppressed = await suppressionCheckImpl(req.template, scope);
    } catch {
      // Bridge failure → treat as not suppressed. Suppression must
      // never falsely silence a suggestion just because the daemon
      // recompute is briefly unavailable.
      suppressed = false;
    }
    if (suppressed) {
      safeLogEvent("suggestion_dropped", {
        template: req.template,
        reason: "suppressed",
        scope,
      });
      return;
    }
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

