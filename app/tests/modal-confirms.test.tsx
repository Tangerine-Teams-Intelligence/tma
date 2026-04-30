/**
 * v1.9.0-beta.3 P3-B — modal-tier confirm UI tests.
 *
 * v1.16 Wave 1: Action 1 (canvas propose-lock) section砍 alongside the
 * /canvas route + AgiStickyAffordances component. Surviving coverage:
 *   1. Source writeback toggles — first OFF→ON in a session pushes the
 *      modal; subsequent toggles skip; modal-budget hard cap drops the
 *      4th modal + logs `modal_budget_exceeded`.
 *
 * Source pages share a common `firstWritebackConfirmedThisSession` Set,
 * so verifying the slack page is sufficient — github / linear /
 * calendar reuse the same primitives.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
// v1.17.4 — Switched from spying on `telemetry.logEvent` to spying on
// `tauri.telemetryLog` because the store no longer goes through the
// `logEvent` wrapper (the dynamic import was breaking Vite's code-split;
// see vite.config.ts manualChunks + telemetry static-only refactor). The
// payload shape is the envelope `{ event, ts, user, payload }` directly,
// not the wrapper's `(name, payload)` tuple.
import * as tauri from "../src/lib/tauri";
import { useStore } from "../src/lib/store";

describe("Action 2: writeback first-time confirm latch", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        modalQueue: [],
        modalsShownThisSession: 0,
        firstWritebackConfirmedThisSession: new Set<string>(),
        toasts: [],
      },
    }));
  });

  it("slack writeback toggle first time pushes modal", () => {
    // Direct store wiring test — mirrors what `persistWithConfirm` does
    // inside the Slack page when the user flips brief from OFF→ON.
    const ui = useStore.getState().ui;
    expect(ui.firstWritebackConfirmedThisSession.has("slack")).toBe(false);

    ui.pushModal({
      id: "slack-writeback-first-time",
      title: "Post to Slack on Tangerine's behalf?",
      body: "…disclosure body…",
      confirmLabel: "Allow Slack posts",
      onCancel: () => {},
      onConfirm: () => ui.markWritebackConfirmed("slack"),
    });

    expect(useStore.getState().ui.modalQueue).toHaveLength(1);
    expect(useStore.getState().ui.modalQueue[0].id).toBe(
      "slack-writeback-first-time",
    );
  });

  it("slack writeback toggle second time skips modal (latch is set)", () => {
    const ui = useStore.getState().ui;
    // First-time confirm latches the source.
    ui.markWritebackConfirmed("slack");
    expect(
      useStore.getState().ui.firstWritebackConfirmedThisSession.has("slack"),
    ).toBe(true);

    // Subsequent OFF→ON in the same session: caller checks the Set
    // *before* deciding whether to push the modal. Replicate that
    // check here.
    const shouldShowModal = !useStore
      .getState()
      .ui.firstWritebackConfirmedThisSession.has("slack");
    expect(shouldShowModal).toBe(false);

    // Sanity: nothing in the queue.
    expect(useStore.getState().ui.modalQueue).toHaveLength(0);
  });

  it("unmarkWritebackConfirmed clears the latch for re-disclosure on next enable", () => {
    const ui = useStore.getState().ui;
    ui.markWritebackConfirmed("github");
    expect(
      useStore.getState().ui.firstWritebackConfirmedThisSession.has("github"),
    ).toBe(true);
    ui.unmarkWritebackConfirmed("github");
    expect(
      useStore.getState().ui.firstWritebackConfirmedThisSession.has("github"),
    ).toBe(false);
  });
});

describe("Modal budget enforcement (≤3 per session)", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        modalQueue: [],
        modalsShownThisSession: 0,
      },
    }));
  });

  it("modal budget exceeded after 3 → 4th drops + logs", async () => {
    const logSpy = vi.spyOn(tauri, "telemetryLog").mockResolvedValue();
    const ui = useStore.getState().ui;

    // First three modals enqueue + bump the counter.
    for (let i = 1; i <= 3; i++) {
      ui.pushModal({
        id: `m${i}`,
        title: `m${i}`,
        body: "x",
        confirmLabel: "OK",
        onCancel: () => {},
        onConfirm: () => {},
      });
    }
    expect(useStore.getState().ui.modalsShownThisSession).toBe(3);
    expect(useStore.getState().ui.modalQueue).toHaveLength(3);

    // 4th drops silently — counter does NOT advance, queue stays at 3.
    ui.pushModal({
      id: "m4",
      title: "m4",
      body: "x",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    expect(useStore.getState().ui.modalsShownThisSession).toBe(3);
    expect(useStore.getState().ui.modalQueue).toHaveLength(3);

    // Telemetry fires fire-and-forget — wait a tick. The envelope shape
    // matches the Rust `TelemetryEvent` struct in src-tauri/src/agi/telemetry.rs.
    await waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "modal_budget_exceeded",
          payload: expect.objectContaining({ dropped: "m4" }),
        }),
      );
    });
  });
});
