/**
 * v1.9.0-beta.1 — suggestion bus + components integration tests.
 *
 * Covers:
 *   - Discipline 6: pushSuggestion respects agiParticipation off
 *   - Discipline 2: pushSuggestion respects confidence floor
 *   - Discipline 1: bannerStack enforces max 1 active visible
 *   - Modal queue FIFO + ≤ 1 modal per session budget
 *   - <Banner> renders + dismiss × works
 *   - <Modal> blocks Esc/backdrop except confirm
 *   - Toast auto-dismiss for suggestion duration
 *   - Telemetry connect/disconnect
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { useStore } from "../src/lib/store";
import {
  pushSuggestion,
  connectChipSink,
  connectTelemetry,
} from "../src/lib/suggestion-bus";
import { Banner } from "../src/components/suggestions/Banner";
import { Modal } from "../src/components/suggestions/Modal";
import { BannerHost } from "../src/components/suggestions/BannerHost";
import { ModalHost } from "../src/components/suggestions/ModalHost";

beforeEach(() => {
  // Reset all suggestion-related state between tests.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      agiParticipation: true,
      agiVolume: "quiet",
      mutedAgiChannels: [],
      dismissedSurfaces: [],
      agiConfidenceThreshold: 0.7,
      bannerStack: [],
      modalQueue: [],
      modalsShownThisSession: 0,
      toasts: [],
    },
  }));
  connectChipSink(null);
  connectTelemetry(null);
});

describe("pushSuggestion — disciplines", () => {
  it("respects agiParticipation off (Discipline 6)", async () => {
    useStore.getState().ui.setAgiParticipation(false);
    await pushSuggestion({
      template: "test",
      body: "hi",
      confidence: 1.0,
      is_cross_route: true,
    });
    expect(useStore.getState().ui.bannerStack).toHaveLength(0);
    expect(useStore.getState().ui.toasts).toHaveLength(0);
    expect(useStore.getState().ui.modalQueue).toHaveLength(0);
  });

  it("respects confidence floor (Discipline 2)", async () => {
    useStore.getState().ui.setAgiConfidenceThreshold(0.85);
    await pushSuggestion({
      template: "test_low",
      body: "low confidence",
      confidence: 0.8,
      is_cross_route: true,
    });
    // Below the user threshold (0.85) → dropped silently.
    expect(useStore.getState().ui.bannerStack).toHaveLength(0);
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });

  it("honours hard MIN_CONFIDENCE floor even when user threshold is below", async () => {
    // Ambient.MIN_CONFIDENCE is 0.7; bus uses Math.max(user, 0.7).
    useStore.getState().ui.setAgiConfidenceThreshold(0.5);
    await pushSuggestion({
      template: "test_below_min",
      body: "below min",
      confidence: 0.65,
    });
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });
});

describe("pushSuggestion — silent volume + irreversible exception (P3-C Polish 3)", () => {
  it("silent volume drops a banner-tier suggestion", async () => {
    useStore.getState().ui.setAgiVolume("silent");
    await pushSuggestion({
      template: "silent_banner",
      body: "would be a banner",
      confidence: 0.95,
      is_cross_route: true,
    });
    expect(useStore.getState().ui.bannerStack).toHaveLength(0);
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });

  it("silent volume drops a toast-tier suggestion", async () => {
    useStore.getState().ui.setAgiVolume("silent");
    await pushSuggestion({
      template: "silent_toast",
      body: "would be a toast",
      confidence: 0.95,
      is_completion_signal: true,
    });
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });

  it("silent volume STILL shows an irreversible modal (Polish 3 exception)", async () => {
    // Hard-stop confirms must never be silenced — that would let the
    // AGI commit destructive actions without the user ever seeing the
    // prompt. Silent gates passive nudges only.
    useStore.getState().ui.setAgiVolume("silent");
    await pushSuggestion({
      template: "silent_modal",
      body: "Tangerine wants to publish to #engineering",
      confidence: 0.95,
      is_irreversible: true,
      title: "Publish?",
      confirmLabel: "Publish",
    });
    expect(useStore.getState().ui.modalQueue).toHaveLength(1);
    expect(useStore.getState().ui.modalsShownThisSession).toBe(1);
  });

  it("silent drop logs telemetry with reason=agi_volume_silent", async () => {
    const fn = vi.fn();
    connectTelemetry(fn);
    useStore.getState().ui.setAgiVolume("silent");
    await pushSuggestion({
      template: "silent_telem",
      body: "x",
      confidence: 0.95,
      is_cross_route: true,
    });
    expect(fn).toHaveBeenCalledWith(
      "suggestion_dropped",
      expect.objectContaining({
        template: "silent_telem",
        reason: "agi_volume_silent",
      }),
    );
  });
});

describe("pushSuggestion — tier routing", () => {
  it("routes irreversible to modal queue", async () => {
    await pushSuggestion({
      template: "publish_decision",
      body: "Tangerine wants to publish to #engineering",
      confidence: 0.95,
      is_irreversible: true,
      title: "Publish?",
      confirmLabel: "Publish",
    });
    expect(useStore.getState().ui.modalQueue).toHaveLength(1);
    expect(useStore.getState().ui.modalsShownThisSession).toBe(1);
  });

  it("routes cross_route + high confidence to banner", async () => {
    await pushSuggestion({
      template: "cross_route_demo",
      body: "3 unresolved decisions detected",
      confidence: 0.9,
      is_cross_route: true,
    });
    expect(useStore.getState().ui.bannerStack).toHaveLength(1);
    expect(useStore.getState().ui.bannerStack[0].body).toBe(
      "3 unresolved decisions detected",
    );
  });

  it("routes default (no signals) to toast", async () => {
    await pushSuggestion({
      template: "generic",
      body: "Decision draft created",
      confidence: 0.95,
      is_completion_signal: true,
    });
    expect(useStore.getState().ui.toasts).toHaveLength(1);
    expect(useStore.getState().ui.toasts[0].kind).toBe("suggestion");
    expect(useStore.getState().ui.toasts[0].msg).toBe(
      "Decision draft created",
    );
  });

  it("falls back to toast when chip is selected but no chip sink is connected", async () => {
    await pushSuggestion({
      template: "chip_demo",
      body: "Maybe link this to /memory/foo.md",
      confidence: 0.85,
      surface_id: "input-1",
    });
    // No sink → toast fallback so the suggestion still surfaces.
    expect(useStore.getState().ui.toasts).toHaveLength(1);
  });

  it("routes chip to the connected sink", async () => {
    const sink = vi.fn();
    connectChipSink(sink);
    await pushSuggestion({
      template: "chip_routed",
      body: "chip body",
      confidence: 0.9,
      surface_id: "surface-x",
    });
    expect(sink).toHaveBeenCalledWith("surface-x", "chip body", 0.9);
    // Chip path doesn't push a toast.
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });
});

describe("modal budget", () => {
  it("demotes the second modal to a banner per spec §3.4", async () => {
    await pushSuggestion({
      template: "first_modal",
      body: "first",
      confidence: 0.95,
      is_irreversible: true,
      title: "First",
      confirmLabel: "OK",
    });
    expect(useStore.getState().ui.modalQueue).toHaveLength(1);

    await pushSuggestion({
      template: "second_modal",
      body: "second",
      confidence: 0.95,
      is_irreversible: true,
      title: "Second",
      confirmLabel: "OK",
    });
    // Second modal demoted.
    expect(useStore.getState().ui.modalQueue).toHaveLength(1);
    expect(useStore.getState().ui.bannerStack).toHaveLength(1);
    expect(useStore.getState().ui.bannerStack[0].body).toBe("second");
  });

  it("modalQueue is FIFO — first push is rendered first", async () => {
    // Push two directly via the store so we bypass the budget cap and
    // can verify FIFO order on the queue itself.
    useStore.getState().ui.pushModal({
      id: "m1",
      title: "First",
      body: "first",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    useStore.getState().ui.pushModal({
      id: "m2",
      title: "Second",
      body: "second",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    const q = useStore.getState().ui.modalQueue;
    expect(q[0].id).toBe("m1");
    expect(q[1].id).toBe("m2");
  });
});

describe("bannerStack — Discipline 1 (max 1 active visible)", () => {
  it("only the highest-priority banner is rendered", () => {
    useStore.getState().ui.pushBanner({
      id: "low",
      body: "low priority",
      priority: 1,
    });
    useStore.getState().ui.pushBanner({
      id: "high",
      body: "high priority",
      priority: 9,
    });
    render(<BannerHost />);
    expect(screen.getByText("high priority")).toBeInTheDocument();
    expect(screen.queryByText("low priority")).toBeNull();
  });

  it("re-pushing the same id deduplicates the entry", () => {
    useStore.getState().ui.pushBanner({
      id: "dup",
      body: "first body",
      priority: 5,
    });
    useStore.getState().ui.pushBanner({
      id: "dup",
      body: "second body",
      priority: 5,
    });
    expect(useStore.getState().ui.bannerStack).toHaveLength(1);
    expect(useStore.getState().ui.bannerStack[0].body).toBe("second body");
  });

  it("dismissing the visible banner reveals the next-highest", () => {
    useStore.getState().ui.pushBanner({
      id: "a",
      body: "A",
      priority: 3,
    });
    useStore.getState().ui.pushBanner({
      id: "b",
      body: "B",
      priority: 5,
    });
    render(<BannerHost />);
    expect(screen.getByText("B")).toBeInTheDocument();

    // Programmatic dismiss of the top entry.
    act(() => {
      useStore.getState().ui.dismissBanner("b");
    });
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});

describe("<Banner/> component", () => {
  it("renders body + dismiss × that fires onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <Banner
        id="b1"
        body="banner body"
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText("banner body")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("suggestion-banner-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders CTA button when ctaLabel is set and fires onAccept", () => {
    const onAccept = vi.fn();
    render(
      <Banner
        id="b2"
        body="with cta"
        ctaLabel="Open"
        onAccept={onAccept}
      />,
    );
    fireEvent.click(screen.getByTestId("suggestion-banner-cta"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("hides the dismiss × when dismissable=false", () => {
    render(
      <Banner
        id="b3"
        body="sticky"
        dismissable={false}
      />,
    );
    expect(screen.queryByTestId("suggestion-banner-dismiss")).toBeNull();
  });
});

describe("<Modal/> component", () => {
  it("renders title + body + Cancel/Confirm buttons", () => {
    render(
      <Modal
        id="m1"
        title="Confirm publish"
        body="Are you sure?"
        confirmLabel="Publish"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("Confirm publish")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-modal-cancel")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-modal-confirm")).toBeInTheDocument();
  });

  it("Esc fires onCancel, not onConfirm", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <Modal
        id="m_esc"
        title="t"
        body="b"
        confirmLabel="OK"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("backdrop click fires onCancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <Modal
        id="m_bd"
        title="t"
        body="b"
        confirmLabel="OK"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    const backdrop = screen.getByTestId("suggestion-modal-backdrop");
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking inside the card does NOT cancel", () => {
    const onCancel = vi.fn();
    render(
      <Modal
        id="m_card"
        title="t"
        body="b"
        confirmLabel="OK"
        onCancel={onCancel}
        onConfirm={() => {}}
      />,
    );
    const card = screen.getByTestId("suggestion-modal-card");
    fireEvent.click(card);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Confirm button is the only path to onConfirm", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <Modal
        id="m_ok"
        title="t"
        body="b"
        confirmLabel="OK"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("suggestion-modal-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("dangerous flag swaps the confirm button to red", () => {
    render(
      <Modal
        id="m_dz"
        title="t"
        body="b"
        confirmLabel="Delete"
        dangerous
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const btn = screen.getByTestId("suggestion-modal-confirm");
    expect(btn.className).toMatch(/rose/);
  });
});

describe("<ModalHost/>", () => {
  it("renders only the head of the queue (FIFO)", () => {
    useStore.getState().ui.pushModal({
      id: "first",
      title: "First modal",
      body: "first body",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    useStore.getState().ui.pushModal({
      id: "second",
      title: "Second modal",
      body: "second body",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    render(<ModalHost />);
    expect(screen.getByText("First modal")).toBeInTheDocument();
    expect(screen.queryByText("Second modal")).toBeNull();
  });

  it("Confirm pops the head and reveals the next", () => {
    useStore.getState().ui.pushModal({
      id: "first",
      title: "First modal",
      body: "first body",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    useStore.getState().ui.pushModal({
      id: "second",
      title: "Second modal",
      body: "second body",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
    });
    render(<ModalHost />);
    fireEvent.click(screen.getByTestId("suggestion-modal-confirm"));
    expect(screen.queryByText("First modal")).toBeNull();
    expect(screen.getByText("Second modal")).toBeInTheDocument();
  });
});

describe("telemetry", () => {
  it("calls connected telemetry on push", async () => {
    const fn = vi.fn();
    connectTelemetry(fn);
    await pushSuggestion({
      template: "telem_demo",
      body: "x",
      confidence: 0.9,
      is_cross_route: true,
    });
    expect(fn).toHaveBeenCalledWith(
      "suggestion_pushed",
      expect.objectContaining({
        template: "telem_demo",
        tier: "banner",
        confidence: 0.9,
      }),
    );
  });

  it("logs a drop event when agiParticipation is off", async () => {
    const fn = vi.fn();
    connectTelemetry(fn);
    useStore.getState().ui.setAgiParticipation(false);
    await pushSuggestion({
      template: "off_demo",
      body: "x",
      confidence: 0.9,
    });
    expect(fn).toHaveBeenCalledWith(
      "suggestion_dropped",
      expect.objectContaining({
        template: "off_demo",
        reason: "agi_participation_off",
      }),
    );
  });
});

describe("pushToast — v1.9 rich form", () => {
  it("legacy 2-arg call still works", () => {
    useStore.getState().ui.pushToast("info", "legacy");
    const t = useStore.getState().ui.toasts[0];
    expect(t.kind).toBe("info");
    expect(t.msg).toBe("legacy");
    expect(t.text).toBe("legacy");
  });

  it("rich form attaches CTA + duration", () => {
    useStore.getState().ui.pushToast({
      kind: "suggestion",
      msg: "rich",
      template: "demo",
      ctaLabel: "Open",
      ctaHref: "/today",
      durationMs: 8000,
    });
    const t = useStore.getState().ui.toasts[0];
    expect(t.kind).toBe("suggestion");
    expect(t.template).toBe("demo");
    expect(t.ctaLabel).toBe("Open");
    expect(t.durationMs).toBe(8000);
  });

  it("error toasts default to no auto-dismiss (durationMs undefined)", () => {
    useStore.getState().ui.pushToast({ kind: "error", msg: "boom" });
    const t = useStore.getState().ui.toasts[0];
    expect(t.durationMs).toBeUndefined();
  });

  it("suggestion toasts default to 4000ms", () => {
    useStore.getState().ui.pushToast({
      kind: "suggestion",
      msg: "bye soon",
    });
    const t = useStore.getState().ui.toasts[0];
    expect(t.durationMs).toBe(4000);
  });
});
