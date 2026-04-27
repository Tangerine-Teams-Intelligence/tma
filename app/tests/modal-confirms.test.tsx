/**
 * v1.9.0-beta.3 P3-B — modal-tier confirm UI tests.
 *
 * Covers the two truly-irreversible flows the bus now gates:
 *   1. Canvas propose-lock — click → modal → confirm calls
 *      `canvasProposeLock`, cancel does NOT.
 *   2. Source writeback toggles — first OFF→ON in a session pushes the
 *      modal; subsequent toggles skip; modal-budget hard cap drops the
 *      4th modal + logs `modal_budget_exceeded`.
 *
 * The store-level latch + budget enforcement is the unit under test for
 * (2). Source pages share a common `firstWritebackConfirmedThisSession`
 * Set, so verifying the slack page is sufficient — github / linear /
 * calendar reuse the same primitives.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AgiStickyAffordances } from "../src/components/canvas/AgiStickyAffordances";
import { ModalHost } from "../src/components/suggestions/ModalHost";
import * as tauri from "../src/lib/tauri";
import * as telemetry from "../src/lib/telemetry";
import { useStore } from "../src/lib/store";
import type { Sticky } from "../src/lib/canvas";

function makeSticky(overrides: Partial<Sticky> = {}): Sticky {
  return {
    id: "modaltest1",
    x: 0,
    y: 0,
    color: "yellow",
    author: "daizhe",
    is_agi: false,
    created_at: "2026-04-26T12:00:00.000Z",
    body: "we should pivot to wearables",
    comments: [],
    ...overrides,
  };
}

function renderHostsAndAffordances(stickies: Sticky[]) {
  // Reset modal queue + budget counter so each test starts clean.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      modalQueue: [],
      modalsShownThisSession: 0,
      firstWritebackConfirmedThisSession: new Set<string>(),
      toasts: [],
    },
  }));
  const hosts = (
    <div>
      {stickies.map((s) => (
        <div
          key={s.id}
          data-testid={`sticky-${s.id}`}
          style={{ position: "absolute", width: 260, height: 120 }}
        />
      ))}
    </div>
  );
  return render(
    <MemoryRouter>
      {hosts}
      <AgiStickyAffordances
        project="tangerine"
        topic="ideation"
        stickies={stickies}
      />
      <ModalHost />
    </MemoryRouter>,
  );
}

describe("Action 1: canvas propose-lock confirm modal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propose-lock click pushes modal first, not direct write", async () => {
    const sticky = makeSticky({ id: "lock1abcdef0" });
    const proposeMock = vi.spyOn(tauri, "canvasProposeLock");

    renderHostsAndAffordances([sticky]);
    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${sticky.id}`));
    const btn = await screen.findByTestId(`propose-lock-${sticky.id}`);

    await act(async () => {
      fireEvent.click(btn);
    });

    // Modal is open, decision atom NOT drafted yet.
    expect(useStore.getState().ui.modalQueue).toHaveLength(1);
    expect(useStore.getState().ui.modalQueue[0].id).toBe(
      `propose-lock-${sticky.id}`,
    );
    expect(proposeMock).not.toHaveBeenCalled();
    // Modal shows the sticky body excerpt for context.
    expect(screen.getByText(/Lock this as a decision/)).toBeInTheDocument();
  });

  it("propose-lock modal confirm calls canvasProposeLock", async () => {
    const sticky = makeSticky({ id: "lock2abcdef0" });
    const proposeMock = vi
      .spyOn(tauri, "canvasProposeLock")
      .mockResolvedValue(
        "/Users/daizhe/.tangerine-memory/decisions/canvas-ideation-lock2abcdef0.md",
      );

    renderHostsAndAffordances([sticky]);
    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${sticky.id}`));

    await act(async () => {
      fireEvent.click(
        await screen.findByTestId(`propose-lock-${sticky.id}`),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("suggestion-modal-confirm"));
    });

    expect(proposeMock).toHaveBeenCalledWith(
      "tangerine",
      "ideation",
      sticky.id,
    );
    // Modal pops off the queue once confirmed.
    await waitFor(() => {
      expect(useStore.getState().ui.modalQueue).toHaveLength(0);
    });
  });

  it("propose-lock modal cancel does NOT call canvasProposeLock", async () => {
    const sticky = makeSticky({ id: "lock3abcdef0" });
    const proposeMock = vi.spyOn(tauri, "canvasProposeLock");

    renderHostsAndAffordances([sticky]);
    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${sticky.id}`));

    await act(async () => {
      fireEvent.click(
        await screen.findByTestId(`propose-lock-${sticky.id}`),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("suggestion-modal-cancel"));
    });

    expect(proposeMock).not.toHaveBeenCalled();
    expect(useStore.getState().ui.modalQueue).toHaveLength(0);
  });
});

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
    const logSpy = vi.spyOn(telemetry, "logEvent").mockResolvedValue();
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

    // Telemetry fires fire-and-forget via dynamic import → wait a tick.
    await waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        "modal_budget_exceeded",
        expect.objectContaining({ dropped: "m4" }),
      );
    });
  });
});
