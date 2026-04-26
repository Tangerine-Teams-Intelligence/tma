/**
 * Thin client for the v1.7 RMS daemon Tauri commands.
 *
 * The daemon (`app/src-tauri/src/daemon.rs`) runs as a background tokio task
 * spawned in `main.rs::setup`. It rebuilds the timeline index, refreshes
 * pending alerts, and writes the daily brief once per day. The frontend
 * touches it through two commands:
 *
 *   - `daemon_status()` — returns the latest heartbeat / pull / brief
 *     timestamps + tail of errors. Render in a debug indicator or settings
 *     panel.
 *   - `daemon_kick()` — force an immediate heartbeat. Useful for "refresh
 *     now" affordances in the /today and /alignment views (Module C).
 *
 * Module C views will likely poll `daemon_status` every ~5s through a
 * Zustand selector. We deliberately do NOT add that polling here — this is
 * just the IPC boundary.
 */

import { invoke } from "@tauri-apps/api/core";

export interface DaemonStatus {
  /** True when the daemon was successfully spawned at app start. */
  running: boolean;
  /** RFC 3339 timestamp of the most recent heartbeat. */
  last_heartbeat: string | null;
  /** RFC 3339 of the last successful `git pull`. Null in solo mode. */
  last_pull: string | null;
  /** RFC 3339 of the last brief generation. */
  last_brief: string | null;
  /** YYYY-MM-DD of the last brief — easier to compare against today. */
  last_brief_date: string | null;
  /** Monotonic counter of heartbeats since process start. */
  heartbeat_count: number;
  /** Most recent ≤20 errors with timestamps. Empty in healthy state. */
  errors: string[];
}

/** Read the daemon's internal state. */
export async function daemonStatus(): Promise<DaemonStatus> {
  return invoke<DaemonStatus>("daemon_status");
}

/** Force the daemon to run a heartbeat right now (no wait for next tick). */
export async function daemonKick(): Promise<void> {
  return invoke("daemon_kick");
}
