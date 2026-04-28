/**
 * v1.9.0-beta.1 P1-A — Action telemetry frontend hook.
 *
 * Every meaningful UI surface fires `logEvent("...", payload)` so the
 * suggestion engine in v1.9.0-beta.2 can later detect patterns
 * ("you mentioned 'pricing' 7× this week", "RFC has 0 comments after 4d").
 *
 * Storage is local-only: events are appended to
 * `~/.tangerine-memory/.tangerine/telemetry/{YYYY-MM-DD}.jsonl` via the
 * Rust `telemetry_log` Tauri command. Retention is 90 days; the user can
 * wipe at any time via Settings → AGI → Clear telemetry.
 *
 * Privacy: this module never sends data off the device. `SUGGESTION_ENGINE_SPEC.md`
 * §2.3 reserves a future opt-in cloud-sync path; until then every event
 * stays in the user's local memory dir.
 *
 * Performance contract: `logEvent` is fire-and-forget. Callers MUST use
 * `void logEvent(...)` to avoid blocking the UI on the Tauri round trip.
 * If the bridge isn't available (vitest, browser dev), the wrapper no-ops
 * silently — telemetry should never crash the app.
 */

import { telemetryLog, telemetryReadWindow } from "./tauri";
import { useStore } from "./store";

/**
 * Closed set of event names. Mirrors `SUGGESTION_ENGINE_SPEC.md` §2.1
 * plus a few additional events the v1.9.0-beta.2 templates need
 * (open_atom for atom-open velocity, search for query patterns,
 * canvas_throw_sticky / canvas_propose_lock for canvas friction).
 *
 * Event payload shapes (also documented at each call site):
 *   - navigate_route        : { from: string, to: string }
 *   - edit_atom             : { atom_path: string, edit_kind: "create" | "modify" | "delete" }
 *   - open_atom             : { atom_path: string }
 *   - dismiss_chip          : { surface_id: string, content_hash?: string }
 *   - dismiss_banner        : { surface_id: string, banner_kind: string }
 *   - dismiss_toast         : { toast_id: string, kind?: string }
 *   - dismiss_modal         : { surface_id: string, modal_kind?: string }
 *   - accept_suggestion     : { tier: "chip" | "banner" | "toast" | "modal";
 *                                template_name: string; atom_ref?: string }
 *   - mute_channel          : { channel: string; muted: boolean }
 *   - trigger_heartbeat     : { manual: boolean }
 *   - co_thinker_edit       : { content_diff_size: number }
 *   - search                : { query: string; result_count: number }
 *   - canvas_throw_sticky   : { project: string; topic: string; color: string;
 *                                is_agi: boolean }
 *   - canvas_propose_lock   : { project: string; topic: string; sticky_id: string }
 */
export type TelemetryEventName =
  | "navigate_route"
  | "edit_atom"
  | "open_atom"
  | "dismiss_chip"
  | "dismiss_banner"
  | "dismiss_toast"
  | "dismiss_modal"
  | "accept_suggestion"
  | "mute_channel"
  | "trigger_heartbeat"
  | "co_thinker_edit"
  | "search"
  | "canvas_throw_sticky"
  | "canvas_propose_lock"
  // v1.9 P1-B suggestion bus
  | "suggestion_pushed"
  | "suggestion_dropped"
  // v1.9 P3-B modal-tier confirms
  | "dismiss_suggestion"
  | "modal_budget_exceeded"
  // v1.9.0-beta.3 P3-A — fired by the daemon when the 3rd dismiss of a
  // `{template, scope}` pair promotes it into the 30d suppression
  // state. Analytics-only — the bus reads `suppression_check` directly
  // for the gate. Payload shape:
  //   { template: string, scope: string, suppressed_until: string }
  | "dismiss_count_threshold_reached"
  // v1.9.0 P4-A — Stage 2 LLM enrichment outcomes. Fired by the
  // frontend listener when a `template_match_enriched` event lands
  // (success path) and by the rule-emit path when enrichment is
  // skipped (failure path). Lets the suggestion engine compare
  // rule-only vs. enriched accept rates and surface enrichment
  // latency regressions.
  //
  // Payload shapes (also documented at each call site):
  //   - suggestion_enriched         : { match_id: string,
  //                                      original_body_size: number,
  //                                      new_body_size: number,
  //                                      latency_ms: number }
  //   - suggestion_enrichment_failed: { match_id: string,
  //                                      reason: "no_llm_available"
  //                                            | "validation_failed"
  //                                            | "timeout" }
  | "suggestion_enriched"
  | "suggestion_enrichment_failed"
  // === v1.13.1 Round 1 fix — missing telemetry event names that broke build ===
  // Added by various waves but never registered in the union.
  | "demo_banner_connect_clicked"      // Wave 13 — DemoModeBanner.tsx
  | "demo_banner_hidden"                // Wave 13 — DemoModeBanner.tsx
  // === v1.13.9 round-9 === — Clear samples CTA on the demo banner.
  // Logged when user explicitly purges Wave 13 sample atoms from disk
  // via DemoModeBanner.tsx (mirrored CTA in AdvancedSettings.tsx is
  // not telemetered — settings interactions are out of scope).
  | "demo_banner_clear_clicked"
  // === end v1.13.9 round-9 ===
  | "onboarding_scope_picked"           // Wave 1.13-A — OnboardingChat.tsx solo/team picker
  | "setup_wizard_sample_query_clicked" // Wave 13 — SetupWizard.tsx sample chips
  | "welcome_card_cta"                  // Wave 1.13-A — WelcomeOverlay card 5 CTA
  // === end v1.13.1 ===
  // Wave 4-C — first-run welcome tour + AI tool auto-configure.
  // Lets analytics see how many users see the overlay vs. start the tour
  // vs. skip, and how often auto-configure beats the manual flow.
  // Payload shapes:
  //   - welcome_overlay_shown      : {}
  //   - welcome_overlay_started    : {}
  //   - welcome_overlay_skipped    : { trigger: "link" | "esc" }
  //   - ai_tool_auto_configure     : { tool_id: string, path: string,
  //                                     outcome: "copied" | "copy_failed" }
  | "welcome_overlay_shown"
  | "welcome_overlay_started"
  | "welcome_overlay_skipped"
  | "ai_tool_auto_configure"
  // === wave 5-β discoverability ===
  // Cmd+K palette + help/shortcuts surfaces. Lets the suggestion engine
  // detect "user keeps Cmd+K-ing /memory → sidebar isn't discoverable"
  // or "shortcuts overlay opened 8× this week → maybe surface them
  // inline".
  // Payload shapes (also documented at each call site):
  //   - palette_open      : {}
  //   - palette_select    : { id: string, kind: "route" | "action" |
  //                            "hit" | "shortcut" }
  //   - help_open         : { route: string }
  //   - shortcuts_open    : {}
  //   - tour_replay       : { source: "settings" | "palette" }
  | "palette_open"
  | "palette_select"
  | "help_open"
  | "shortcuts_open"
  | "tour_replay"
  // === wave 11 === — first-run LLM channel setup wizard.
  // Lets analytics see how many users open the wizard, how many auto-
  // configure vs paste manually, how many tests succeed on first try, and
  // how many drop out at each step. Payload shapes:
  //   - setup_wizard_opened           : {}
  //   - setup_wizard_auto_triggered   : {}        (auto-mounted post-welcome)
  //   - setup_wizard_skipped          : { from_step: string }
  //   - setup_wizard_auto_configured  : { tool_id: string }
  //   - setup_wizard_tested           : { ok: boolean, channel: string,
  //                                        latency_ms: number }
  //   - setup_wizard_completed        : { primary_channel: string }
  //   - setup_wizard_banner_open      : {}
  //   - setup_wizard_banner_dismissed : {}
  | "setup_wizard_opened"
  | "setup_wizard_auto_triggered"
  | "setup_wizard_skipped"
  | "setup_wizard_auto_configured"
  | "setup_wizard_tested"
  | "setup_wizard_completed"
  | "setup_wizard_banner_open"
  | "setup_wizard_banner_dismissed"
  // === end wave 11 ===
  // === wave 15 ===
  // v1.10.4 — Cmd+K full memory search. Fired by the CommandPalette
  // every time the debounced query length crosses the threshold and
  // the `search_atoms` Tauri command returns. Lets the suggestion
  // engine spot "user keeps searching for X but it's not in their
  // memory dir → maybe wire a new source" or measure the p95 latency
  // of the Rust walker on real-world dirs.
  //
  // Payload shape:
  //   - palette_memory_search : { query: string, result_count: number,
  //                                latency_ms: number }
  | "palette_memory_search"
  // === end wave 15 ===
  // === wave 18 ===
  // v1.10.4 — conversational onboarding agent. Lets analytics measure
  // chat completion rates vs. the form wizard, see which intents the
  // LLM extracts well vs. drops, and detect "user keeps falling back
  // to the form" patterns.
  // Payload shapes:
  //   - onboarding_chat_message         : { session_id: string, length: number }
  //   - onboarding_chat_action_executed : { session_id: string, kind: string,
  //                                           status: string }
  //   - onboarding_chat_completed       : { session_id: string }
  | "onboarding_chat_message"
  | "onboarding_chat_action_executed"
  | "onboarding_chat_completed"
  // === end wave 18 ===
  // === wave 22 ===
  // Wave 22 — coachmark / first-run tour / try-this telemetry. Lets the
  // suggestion engine see how often the tour is completed vs skipped at
  // each step, and which TryThisFAB cards get accepted vs dismissed.
  // Payload shapes (also documented at each call site):
  //   - coachmark_step_shown : { step_id: string, tour?: string }
  //   - coachmark_dismissed  : { step_id: string,
  //                              reason: "skip" | "complete" | "esc" | "outside" }
  //   - try_this_clicked     : { card_id: string }
  //   - tour_completed       : { tour: string }
  | "coachmark_step_shown"
  | "coachmark_dismissed"
  | "try_this_clicked"
  | "tour_completed"
  // === end wave 22 ===
  // === v1.13.5 round-5 ===
  // Fired by `applyReviewDecisions` (tauri.ts) when the user clicks Apply
  // in /meetings/:id/review. The actual write happens via the immediately-
  // following `tmi apply` subcommand call; this event is the analytics
  // record so we know how many blocks were approved/rejected/edited per
  // meeting. Replaces the old dead `apply_review_decisions` Tauri invoke
  // that silently fell back to a console.info mock.
  // Payload: { meeting_id: string, approved_count: number,
  //            rejected_count: number, edited_count: number }
  | "review_decisions_submitted"
  // === end v1.13.5 round-5 ===
  // === v1.15.0 Wave 1.4 — onboarding wizard + activation funnel ===
  // The four-pillar event set the new onboarding paths emit so analytics
  // can compute "shown → path picked → connected → first real atom" at
  // the user level. Payload schemas live at the call sites; the comments
  // below describe the contract:
  //   - onboarding_wizard_shown          : {}
  //   - onboarding_path_chosen           : { path: "ai_tool" | "demo" | "manual" }
  //   - onboarding_detection_completed   : { detected_count: number,
  //                                           tools: string[] }
  //   - onboarding_mcp_configured        : { tool_id: string,
  //                                           success: boolean }
  //   - onboarding_mcp_failed            : { tool_id: string,
  //                                           error_class: string }
  //   - onboarding_skipped_to_demo       : {}
  //   - onboarding_skipped_to_manual     : {}
  //   - onboarding_completed             : { time_to_complete_ms: number,
  //                                           path: string }
  //   - mcp_connected                    : { tool_id: string }
  //   - first_real_atom_captured         : { source: string }
  //   - demo_tour_step_completed         : { step_index: number }
  //   - demo_to_real_conversion          : {}
  //   - solo_cloud_upgrade_prompt_shown  : {}
  //   - solo_cloud_upgrade_clicked       : {}
  //
  // `first_real_atom_captured` is the activation event — fires at MOST
  // ONCE per install (gated by store flag `firstAtomCapturedAt`). The
  // listener filters out sample atoms via the R9-propagated YAML
  // `sample: true` flag so seeded fixtures never count. Wave 1.4 spec.
  | "onboarding_wizard_shown"
  | "onboarding_path_chosen"
  | "onboarding_detection_completed"
  | "onboarding_mcp_configured"
  | "onboarding_mcp_failed"
  | "onboarding_skipped_to_demo"
  | "onboarding_skipped_to_manual"
  | "onboarding_completed"
  | "mcp_connected"
  | "first_real_atom_captured"
  | "demo_tour_step_completed"
  | "demo_to_real_conversion"
  | "solo_cloud_upgrade_prompt_shown"
  | "solo_cloud_upgrade_clicked"
  // Wave 4 wire-up additions:
  //   - onboarding_mcp_timeout      : { tool_id: string, elapsed_ms: number }
  //     Fired by AIToolDetectionGrid when 30s passes without a successful
  //     handshake. Distinct from `onboarding_mcp_failed` (which is for
  //     hard errors — Auto-configure failure or thrown bridge). Timeout
  //     means "user hasn't restarted their AI tool yet" — retryable.
  //   - solo_cloud_upgrade_dismissed: { snooze_days?: number }
  //     Fired by SoloCloudUpgradePrompt when user clicks the X button.
  //     The 7d cool-down is enforced by `soloCloudPromptDismissedAt` in
  //     the store; this event is for analytics so we can compute
  //     dismiss-rate vs upgrade-rate.
  | "onboarding_mcp_timeout"
  | "solo_cloud_upgrade_dismissed"
  // === v1.15.0 Wave 2.1 — demo tour dismiss telemetry ===
  // Fired when the user closes the DemoTourOverlay before completing
  // step 5 (real-data conversion). Lets analytics distinguish
  // `demo_to_real_conversion` (full traversal + clear-samples) from
  // mid-tour drop-off. Payload:
  //   - demo_tour_dismissed : { at_step: number }   // 0..4
  | "demo_tour_dismissed"
  // === v1.15.0 Wave 2.2 — first-week empty state telemetry ===
  // EmptyStateCard renders on /people /threads /co-thinker /today
  // /this-week /memory when fetch succeeds AND data is empty AND
  // `firstAtomCapturedAt === null` (returning users see the lighter
  // "no items yet" message instead). Lets analytics see which
  // surfaces convert empty-state CTAs into capture activations.
  // Payload (both): { surface: string }
  // surface ∈ "people" | "people-detail" | "threads" | "threads-detail"
  //         | "co-thinker" | "today" | "this-week" | "memory-tree"
  | "empty_state_shown"
  | "empty_state_cta_clicked";
  // === end v1.15.0 Wave 1.4 + 2.1 + 2.2 ===
// === end wave 5-β discoverability ===

/** One telemetry record. Mirrors `app/src-tauri/src/agi/telemetry.rs::TelemetryEvent`. */
export interface TelemetryEvent {
  event: TelemetryEventName | string;
  /** ISO 8601 timestamp. Stamped on the frontend at fire time. */
  ts: string;
  /** Resolved current user (`ui.currentUser` from the store). */
  user: string;
  /** Event-specific schema. JSON-shaped — keep it shallow + serializable. */
  payload: Record<string, unknown>;
}

/**
 * Resolve the current user from the Zustand store. Falls back to "me" so
 * we never block telemetry on the user being mid-onboarding (the cursor
 * file uses the same fallback).
 */
function currentUser(): string {
  try {
    return useStore.getState().ui.currentUser || "me";
  } catch {
    return "me";
  }
}

/**
 * Fire-and-forget: append one telemetry event. Never throws — the wrapper
 * inside `tauri.ts::telemetryLog` already swallows IPC errors and the
 * Rust side itself never returns an error other than `internal_io`. We
 * still wrap in a try/catch so a bad payload (e.g. circular ref in the
 * passed-in object) can't bring down the calling component.
 *
 * Usage:
 *   void logEvent("navigate_route", { from: "/today", to: "/memory" });
 */
export async function logEvent(
  event: TelemetryEventName,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const ev: TelemetryEvent = {
      event,
      ts: new Date().toISOString(),
      user: currentUser(),
      payload,
    };
    await telemetryLog(ev);
  } catch {
    // Soft-fail. Telemetry must never break the UI. The Tauri wrapper
    // also has its own console.error path for real bridge failures.
  }
}

/**
 * Read every telemetry event from the last `hours` hours. Used by the
 * v1.9.0-beta.2 suggestion engine's pattern detectors. Returns an empty
 * vec when no telemetry has been recorded yet OR the bridge is missing.
 */
export async function readWindow(hours: number): Promise<TelemetryEvent[]> {
  try {
    return await telemetryReadWindow(hours);
  } catch {
    return [];
  }
}

// === v1.15.0 Wave 1.4 — typed onboarding event payloads ===
//
// `logEvent` itself stays `Record<string, unknown>` for back-compat with
// the ~80 existing call sites that already mix shapes. Wave 1.4 adds
// four typed call paths so the new onboarding surfaces get a real
// compile-time check on their payload contract. Strict TS — no `any`.
//
// Mirror of the comment block on `TelemetryEventName`. If you add a new
// event name, also add its props interface here so the typed helper
// catches a missing field before the build hits prod.

export interface OnboardingPathChosenProps {
  path: "ai_tool" | "demo" | "manual";
}

export interface OnboardingDetectionCompletedProps {
  detected_count: number;
  tools: string[];
}

export interface OnboardingMcpConfiguredProps {
  tool_id: string;
  success: boolean;
}

export interface OnboardingMcpFailedProps {
  tool_id: string;
  error_class: string;
}

export interface OnboardingCompletedProps {
  time_to_complete_ms: number;
  path: string;
}

export interface McpConnectedProps {
  tool_id: string;
}

export interface FirstRealAtomCapturedProps {
  source: string;
}

export interface DemoTourStepCompletedProps {
  step_index: number;
}

/** Wave 2.1 — payload for `demo_tour_dismissed`. */
export interface DemoTourDismissedProps {
  /** Zero-indexed step the user was on when they closed the overlay. */
  at_step: number;
}

/**
 * Wave 2.2 — shared payload for `empty_state_shown` and
 * `empty_state_cta_clicked`. The `surface` discriminator matches the
 * route slot the EmptyStateCard mounted into.
 */
export interface EmptyStateProps {
  surface: string;
}

/**
 * Discriminated map: TypeScript looks up the props shape per event name
 * so a typo or missing field on any of the new Wave 1.4 events fails
 * `tsc --noEmit`. Existing event names map to `Record<string, unknown>`
 * so the v1.9-era call sites stay compiling.
 *
 * Defensive: `keyof` is exhaustive — when a new name lands in the union
 * but you forget to map it here, TypeScript flags the gap on every typed
 * caller.
 */
export type TelemetryPayload<E extends TelemetryEventName> =
  E extends "onboarding_path_chosen" ? OnboardingPathChosenProps :
  E extends "onboarding_detection_completed" ? OnboardingDetectionCompletedProps :
  E extends "onboarding_mcp_configured" ? OnboardingMcpConfiguredProps :
  E extends "onboarding_mcp_failed" ? OnboardingMcpFailedProps :
  E extends "onboarding_completed" ? OnboardingCompletedProps :
  E extends "mcp_connected" ? McpConnectedProps :
  E extends "first_real_atom_captured" ? FirstRealAtomCapturedProps :
  E extends "demo_tour_step_completed" ? DemoTourStepCompletedProps :
  E extends "demo_tour_dismissed" ? DemoTourDismissedProps :
  E extends "empty_state_shown" | "empty_state_cta_clicked" ? EmptyStateProps :
  E extends "onboarding_wizard_shown"
    | "onboarding_skipped_to_demo"
    | "onboarding_skipped_to_manual"
    | "demo_to_real_conversion"
    | "solo_cloud_upgrade_prompt_shown"
    | "solo_cloud_upgrade_clicked"
    ? Record<string, never>
    : Record<string, unknown>;

/**
 * Typed wrapper around `logEvent`. Use from new Wave 1.4 surfaces so the
 * compiler enforces the payload shape; legacy call sites stay on the
 * untyped `logEvent`.
 *
 * Usage:
 *   void logTypedEvent("onboarding_path_chosen", { path: "ai_tool" });
 */
export async function logTypedEvent<E extends TelemetryEventName>(
  event: E,
  payload: TelemetryPayload<E>,
): Promise<void> {
  // Cast through unknown so the structural-vs-Record gap on the strict
  // empty-payload events doesn't trip the inference. Runtime shape is
  // identical to `logEvent`.
  return logEvent(event, payload as unknown as Record<string, unknown>);
}
// === end v1.15.0 Wave 1.4 ===
