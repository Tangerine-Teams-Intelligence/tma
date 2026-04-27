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
  | "suggestion_dropped";

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
