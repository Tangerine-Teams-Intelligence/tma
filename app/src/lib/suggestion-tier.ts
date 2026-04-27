/**
 * v1.9.0-beta.1 — Tier-selection engine.
 *
 * Pure function that maps a `SuggestionRequest` to one of the four visual
 * tiers (chip / banner / toast / modal). Lives in its own module so it's
 * unit-testable without dragging in zustand or React. Decision logic
 * mirrors `SUGGESTION_ENGINE_SPEC.md` §3.5.
 *
 * The rules, in priority order:
 *   1. `is_irreversible === true`         → modal (RARE; budget ≤ 1/session)
 *   2. `is_completion_signal === true`    → toast
 *   3. `is_cross_route === true`
 *      AND confidence ≥ 0.8               → banner
 *   4. `surface_id` provided              → chip
 *   5. otherwise                          → toast (default catch-all)
 *
 * Confidence-aware fallback: a request that *would* be a banner but
 * doesn't clear the 0.8 confidence bar drops to a toast. This matches
 * the spec table row "Confidence < 0.85 + cross-route → banner (NOT
 * modal)" by treating the modal requirement as the higher bar; for a
 * banner we use 0.8 because v1.8's `MIN_CONFIDENCE` floor is 0.7 and
 * the banner is the next step up the visibility ladder.
 *
 * NOTE: this module does NOT enforce the `agiParticipation` master
 * switch, the confidence-floor gate, or the throttle/dismiss memory.
 * Those live in `suggestion-bus.ts` (the dispatcher), so the tier
 * selector itself remains a pure mapping function.
 */

export type SuggestionTier = "chip" | "banner" | "toast" | "modal";

/**
 * Confidence floor for promoting a cross-route suggestion to a banner.
 * Below this we drop to a toast — banners persist across route changes
 * and are the most visually heavy non-modal tier, so a low-confidence
 * suggestion never gets that real estate.
 */
export const BANNER_CONFIDENCE_FLOOR = 0.8;

/**
 * The full request shape any caller passes to `pushSuggestion`. Only the
 * `template`, `body`, and `confidence` fields are required; the rest are
 * tier-specific signals that the selector reads to decide where to land.
 */
export interface SuggestionRequest {
  /** Template name from §4 (e.g. "stale_rfc", "decision_drift"). The bus
   *  also forwards this into the telemetry payload. */
  template: string;
  /** The user-visible body text. Markdown allowed for chip/banner/toast. */
  body: string;
  /** 0..1, fed into the tier engine + the v1.8 confidence floor in the bus. */
  confidence: number;
  /** True for irreversible AGI proposals — promotes to modal. */
  is_irreversible?: boolean;
  /** True for "Decision draft created" / "Tangerine summarized this thread"
   *  one-shots — pinned to toast tier so completion notices never escalate. */
  is_completion_signal?: boolean;
  /** True when the suggestion applies regardless of current route — eligible
   *  for banner tier (subject to confidence floor). */
  is_cross_route?: boolean;
  /** Anchor surface id for chip tier — when provided + no other signal
   *  fires, we render inline next to the input. */
  surface_id?: string;
  /** 0..10; higher wins when a banner slot is contested. Default 5. */
  priority?: number;
  /** Optional CTA + handler. Renders a button in banner / toast / modal. */
  ctaLabel?: string;
  ctaHref?: string;
  onAccept?: () => void;
  /** Modal-only: title + confirm/cancel labels. */
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Modal-only: style the confirm button red for destructive actions. */
  dangerous?: boolean;
}

/**
 * Pure tier selector. Implements the rule table in §3.5 of the spec.
 *
 * Rule precedence is intentional: irreversibility wins outright (we never
 * silently demote a destructive confirmation to a toast). Completion
 * signals are pinned next so a "draft created" notice is never escalated
 * to a banner even if `is_cross_route` is also set.
 */
export function selectTier(req: SuggestionRequest): SuggestionTier {
  if (req.is_irreversible === true) return "modal";
  if (req.is_completion_signal === true) return "toast";
  if (req.is_cross_route === true) {
    if (req.confidence >= BANNER_CONFIDENCE_FLOOR) return "banner";
    // Cross-route but low confidence — fall through to toast rather than
    // claim a banner slot at sub-floor confidence.
    return "toast";
  }
  if (req.surface_id) return "chip";
  return "toast";
}
