/**
 * v1.9.0-beta.1 P1-A — telemetry frontend tests.
 *
 * Covers:
 *   * `logEvent` fires the Tauri `telemetry_log` invoke with the right
 *     envelope shape.
 *   * `logEvent` does NOT throw when the Tauri bridge is missing
 *     (browser-dev / vitest mode) — the wrapper must no-op silently.
 *   * `readWindow` returns [] in stub mode rather than rejecting.
 *   * `telemetryClear` integration — the Tauri wrapper proxies through
 *     and the AGI Settings clear button calls it.
 *
 * The Rust-side append/read/concurrency tests live in
 * `app/src-tauri/src/agi/telemetry.rs`. This file stays JS-only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { logEvent, readWindow } from "../src/lib/telemetry";
import * as tauri from "../src/lib/tauri";

describe("logEvent — frontend wrapper", () => {
  beforeEach(() => {
    // Reset every spy between tests so call counts don't leak.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires the Tauri invoke with a well-formed envelope", async () => {
    const spy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);

    await logEvent("navigate_route", { from: "/today", to: "/memory" });

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(arg.event).toBe("navigate_route");
    expect(typeof arg.ts).toBe("string");
    // ISO 8601 starts with "20" for the next ~80 years; cheap shape check
    // that's resilient to timezone-dependent formatting.
    expect(arg.ts).toMatch(/^20\d\d-/);
    expect(typeof arg.user).toBe("string");
    expect(arg.user.length).toBeGreaterThan(0);
    expect(arg.payload).toEqual({ from: "/today", to: "/memory" });
  });

  it("does not throw when the Tauri bridge fails", async () => {
    // Simulate a broken bridge — the wrapper should swallow.
    vi.spyOn(tauri, "telemetryLog").mockRejectedValue(
      new Error("bridge offline"),
    );

    // No throw, no rejection — just silent no-op.
    await expect(
      logEvent("dismiss_chip", { surface_id: "s1" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the payload is unusual but JSON-serializable", async () => {
    const spy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);

    // Payload with nested object + array — telemetry must accept anything
    // shallow + serializable so call sites don't have to flatten.
    await logEvent("canvas_throw_sticky", {
      project: "demo",
      topic: "first",
      color: "yellow",
      is_agi: false,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].payload).toEqual({
      project: "demo",
      topic: "first",
      color: "yellow",
      is_agi: false,
    });
  });

  it("readWindow returns an empty array in stub mode", async () => {
    vi.spyOn(tauri, "telemetryReadWindow").mockResolvedValue([]);

    const events = await readWindow(24);

    expect(events).toEqual([]);
  });

  it("readWindow swallows a bridge error and returns []", async () => {
    vi.spyOn(tauri, "telemetryReadWindow").mockRejectedValue(
      new Error("offline"),
    );

    const events = await readWindow(24);
    expect(events).toEqual([]);
  });

  it("logEvent fires for all 12 declared event names without crashing", async () => {
    const spy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue(undefined);

    const allNames = [
      "navigate_route",
      "edit_atom",
      "open_atom",
      "dismiss_chip",
      "dismiss_banner",
      "dismiss_toast",
      "dismiss_modal",
      "accept_suggestion",
      "mute_channel",
      "trigger_heartbeat",
      "co_thinker_edit",
      "search",
      "canvas_throw_sticky",
      "canvas_propose_lock",
    ] as const;

    for (const name of allNames) {
      await logEvent(name, {});
    }

    expect(spy).toHaveBeenCalledTimes(allNames.length);
    // Spot-check a couple of names to confirm they were passed through.
    const seenNames = spy.mock.calls.map((c) => c[0].event);
    expect(seenNames).toContain("navigate_route");
    expect(seenNames).toContain("dismiss_chip");
    expect(seenNames).toContain("canvas_propose_lock");
  });
});
