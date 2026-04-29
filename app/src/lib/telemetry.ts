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
 * v1.16 Wave 1 — capture + visualize only. Smart layer砍. Old chat
 * onboarding / co-thinker / canvas / Solo Cloud / 8-tool detection /
 * setup-wizard sampling test / demo-tour / activation events all gone.
 * W2/W3 reintroduce a fresh onboarding telemetry surface.
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
 *   - search                : { query: string; result_count: number }
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
  | "search"
  // v1.9 P1-B suggestion bus
  | "suggestion_pushed"
  | "suggestion_dropped"
  // v1.9 P3-B modal-tier confirms
  | "dismiss_suggestion"
  | "modal_budget_exceeded"
  // v1.9.0-beta.3 P3-A — fired by the daemon when the 3rd dismiss of a
  // `{template, scope}` pair promotes it into the 30d suppression
  // state. Analytics-only — the bus reads `suppression_check` directly
  // for the gate.
  | "dismiss_count_threshold_reached"
  // v1.9.0 P4-A — Stage 2 enrichment outcomes. Surface for non-LLM
  // template enrichment (e.g. atom-ref expansion). The LLM-enrichment
  // failure event was砍 in v1.16 Wave 1 (LLM layer砍).
  | "suggestion_enriched"
  // === v1.13.1 Round 1 — DemoModeBanner events. Banner stays as a
  // sample-data surface; LLM-related demo events砍.
  | "demo_banner_connect_clicked"      // Wave 13 — DemoModeBanner.tsx
  | "demo_banner_hidden"                // Wave 13 — DemoModeBanner.tsx
  // === v1.13.9 round-9 === — Clear samples CTA on the demo banner.
  | "demo_banner_clear_clicked"
  // === end v1.13.9 round-9 ===
  // === help / shortcuts overlay (R5 discoverability) ===
  | "help_open"
  | "shortcuts_open"
  | "tour_replay"
  // === wave 15 ===
  // v1.10.4 — Cmd+K full memory search. Fired by the CommandPalette
  // every time the debounced query length crosses the threshold and
  // the `search_atoms` Tauri command returns.
  //
  // Payload shape:
  //   - palette_memory_search : { query: string, result_count: number,
  //                                latency_ms: number }
  | "palette_memory_search"
  // CommandPalette open + selection. Smart-layer砍 in v1.16 W1 spared
  // these two — the palette itself stays.
  //   - palette_open   : { trigger: "shortcut" | "click" | string }
  //   - palette_select : { item_id: string, kind?: string }
  | "palette_open"
  | "palette_select"
  // === end wave 15 ===
  // === wave 22 — coachmark / first-run tour / try-this telemetry ===
  // FirstRunTour + TryThisFAB still render in AppShell; their telemetry
  // stays. Onboarding-tour (wave 1.15 W2.1) was砍 alongside the chat
  // onboarding surface.
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
  // in /meetings/:id/review.
  | "review_decisions_submitted";

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

// === v1.16 Wave 1 ===
// `logTypedEvent` + onboarding payload props were砍 alongside the
// onboarding chat / wizard / activation surfaces. Wave 2/3 will land
// fresh typed payloads when the new onboarding telemetry surface ships.
//
// Until then, every call site goes through the untyped `logEvent` above
// (Record<string, unknown> payload) — sufficient for the surviving
// nav / search / coachmark / suggestion / review event set.
// === end v1.16 Wave 1 ===
