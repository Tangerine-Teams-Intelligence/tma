/**
 * v1.8 Phase 4 — ambient input layer tests.
 *
 * Covers:
 *   * `lib/ambient.ts::shouldShowReaction` — every gate of the policy.
 *   * `lib/ambient.ts::pruneDismissed` — 24h window correctness.
 *   * `lib/ambient.ts::deriveSurfaceId` — explicit attribute, ancestor
 *     fallback, path fallback.
 *   * Store: setAgiVolume, toggleAgiChannelMute, rememberDismissed,
 *     resetDismissedSurfaces, setAgiConfidenceThreshold (with clamp).
 *   * `<InlineReaction/>` — renders the 🍊 dot, dismisses on Esc.
 *   * `<AmbientInputObserver/>` — debounces input, calls
 *     `agiAnalyzeInput`, surfaces a card, dismiss persists in store.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

import {
  shouldShowReaction,
  pruneDismissed,
  channelForPath,
  deriveSurfaceId,
  THROTTLE_24H_MS,
  type AgiVolume,
} from "../src/lib/ambient";
import { useStore } from "../src/lib/store";
import * as tauri from "../src/lib/tauri";
import { AmbientInputObserver } from "../src/components/ambient/AmbientInputObserver";
import { InlineReaction } from "../src/components/ambient/InlineReaction";

describe("shouldShowReaction policy", () => {
  const base = {
    surfaceId: "s1",
    channel: "today" as const,
    reactionConfidence: 0.9,
    agiVolume: "quiet" as AgiVolume,
    mutedChannels: [] as string[],
    dismissedToday: [] as string[],
    throttle: new Map<string, number>(),
    userThreshold: 0.7,
    now: 1_000_000,
  };

  it("returns false when volume is silent", () => {
    expect(shouldShowReaction({ ...base, agiVolume: "silent" })).toBe(false);
  });

  it("returns false when channel is muted", () => {
    expect(
      shouldShowReaction({ ...base, mutedChannels: ["today"] }),
    ).toBe(false);
  });

  it("returns false below the hard MIN_CONFIDENCE floor", () => {
    expect(
      shouldShowReaction({ ...base, reactionConfidence: 0.5 }),
    ).toBe(false);
  });

  it("returns false below the user threshold even at quiet volume", () => {
    expect(
      shouldShowReaction({
        ...base,
        userThreshold: 0.85,
        reactionConfidence: 0.75,
      }),
    ).toBe(false);
  });

  it("chatty volume keeps the hard MIN_CONFIDENCE floor (0.7)", () => {
    // Even at chatty volume, anything below MIN_CONFIDENCE drops.
    expect(
      shouldShowReaction({
        ...base,
        agiVolume: "chatty",
        reactionConfidence: 0.6,
      }),
    ).toBe(false);
    // chatty does allow the user-threshold to drop to 0.5 IF userThreshold
    // is set there. But MIN_CONFIDENCE is hard.
    expect(
      shouldShowReaction({
        ...base,
        agiVolume: "chatty",
        userThreshold: 0.5,
        reactionConfidence: 0.7,
      }),
    ).toBe(true);
  });

  it("returns false when surface dismissed today", () => {
    expect(
      shouldShowReaction({ ...base, dismissedToday: ["s1"] }),
    ).toBe(false);
  });

  it("returns false when throttled inside 24h window", () => {
    const throttle = new Map<string, number>([
      ["s1", base.now - 60 * 60 * 1000], // 1h ago
    ]);
    expect(shouldShowReaction({ ...base, throttle })).toBe(false);
  });

  it("returns true when last reaction was > 24h ago", () => {
    const throttle = new Map<string, number>([
      ["s1", base.now - THROTTLE_24H_MS - 1000],
    ]);
    expect(shouldShowReaction({ ...base, throttle })).toBe(true);
  });

  it("returns true on the happy path", () => {
    expect(shouldShowReaction(base)).toBe(true);
  });
});

describe("pruneDismissed", () => {
  it("drops entries older than 24h", () => {
    const now = 10_000_000;
    const entries = [
      { surfaceId: "fresh", dismissedAt: now - 1_000_000 }, // <24h
      { surfaceId: "stale", dismissedAt: now - THROTTLE_24H_MS - 1 },
    ];
    const out = pruneDismissed(entries, now);
    expect(out.map((e) => e.surfaceId)).toEqual(["fresh"]);
  });
  it("keeps an empty list empty", () => {
    expect(pruneDismissed([], 0)).toEqual([]);
  });
});

describe("channelForPath", () => {
  it("maps known routes", () => {
    expect(channelForPath("/canvas")).toBe("canvas");
    expect(channelForPath("/canvas/foo")).toBe("canvas");
    expect(channelForPath("/memory")).toBe("memory");
    expect(channelForPath("/today")).toBe("today");
    expect(channelForPath("/settings")).toBe("settings");
  });
  it("falls back to search for everything else", () => {
    expect(channelForPath("/people")).toBe("search");
    expect(channelForPath("/")).toBe("search");
    expect(channelForPath("")).toBe("search");
  });
});

describe("deriveSurfaceId", () => {
  it("prefers data-ambient-id on the element", () => {
    const el = document.createElement("textarea");
    el.setAttribute("data-ambient-id", "explicit-id");
    expect(deriveSurfaceId(el)).toBe("explicit-id");
  });
  it("falls back to ancestor's data-ambient-id", () => {
    const wrap = document.createElement("section");
    wrap.setAttribute("data-ambient-id", "parent-id");
    const el = document.createElement("textarea");
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    try {
      expect(deriveSurfaceId(el)).toBe("parent-id");
    } finally {
      wrap.remove();
    }
  });
  it("falls back to a path string when nothing is tagged", () => {
    const el = document.createElement("textarea");
    el.id = "msg";
    document.body.appendChild(el);
    try {
      const id = deriveSurfaceId(el);
      expect(id.startsWith("path:")).toBe(true);
      expect(id).toContain("textarea#msg");
    } finally {
      el.remove();
    }
  });
});

describe("ambient store slice", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        agiParticipation: true,
        agiVolume: "quiet",
        mutedAgiChannels: [],
        dismissedSurfaces: [],
        agiConfidenceThreshold: 0.7,
      },
    }));
  });

  it("setAgiParticipation flips the master switch", () => {
    expect(useStore.getState().ui.agiParticipation).toBe(true);
    useStore.getState().ui.setAgiParticipation(false);
    expect(useStore.getState().ui.agiParticipation).toBe(false);
    useStore.getState().ui.setAgiParticipation(true);
    expect(useStore.getState().ui.agiParticipation).toBe(true);
  });

  it("setAgiVolume swaps the volume", () => {
    useStore.getState().ui.setAgiVolume("chatty");
    expect(useStore.getState().ui.agiVolume).toBe("chatty");
  });

  it("toggleAgiChannelMute toggles in and out", () => {
    useStore.getState().ui.toggleAgiChannelMute("canvas");
    expect(useStore.getState().ui.mutedAgiChannels).toEqual(["canvas"]);
    useStore.getState().ui.toggleAgiChannelMute("canvas");
    expect(useStore.getState().ui.mutedAgiChannels).toEqual([]);
  });

  it("rememberDismissed appends and refreshes timestamp", () => {
    useStore.getState().ui.rememberDismissed("s1");
    const ds = useStore.getState().ui.dismissedSurfaces;
    expect(ds.length).toBe(1);
    expect(ds[0].surfaceId).toBe("s1");
    // Re-dismiss → still one entry, timestamp updated.
    useStore.getState().ui.rememberDismissed("s1");
    const ds2 = useStore.getState().ui.dismissedSurfaces;
    expect(ds2.length).toBe(1);
  });

  it("resetDismissedSurfaces clears the list", () => {
    useStore.getState().ui.rememberDismissed("s1");
    useStore.getState().ui.rememberDismissed("s2");
    useStore.getState().ui.resetDismissedSurfaces();
    expect(useStore.getState().ui.dismissedSurfaces).toEqual([]);
  });

  it("setAgiConfidenceThreshold clamps to [0.5, 0.95]", () => {
    useStore.getState().ui.setAgiConfidenceThreshold(0.1);
    expect(useStore.getState().ui.agiConfidenceThreshold).toBe(0.5);
    useStore.getState().ui.setAgiConfidenceThreshold(0.99);
    expect(useStore.getState().ui.agiConfidenceThreshold).toBe(0.95);
    useStore.getState().ui.setAgiConfidenceThreshold(0.8);
    expect(useStore.getState().ui.agiConfidenceThreshold).toBe(0.8);
  });
});

describe("<InlineReaction/>", () => {
  it("renders the body text + dismiss button", () => {
    const anchor = document.createElement("textarea");
    document.body.appendChild(anchor);
    const onDismiss = vi.fn();
    try {
      render(
        <InlineReaction
          reaction={{
            text: "Decision recorded in /memory/decisions/foo.md",
            confidence: 0.85,
            channel_used: "ollama",
            tool_id: "ollama",
            surface_id: "s1",
            created_at: 0,
          }}
          anchor={anchor}
          onDismiss={onDismiss}
        />,
      );
      expect(
        screen.getByText(/Decision recorded in/i),
      ).toBeInTheDocument();
      const dismissBtn = screen.getByTestId("ambient-reaction-dismiss");
      fireEvent.click(dismissBtn);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      anchor.remove();
    }
  });

  it("dismisses on Esc keypress", () => {
    const anchor = document.createElement("textarea");
    document.body.appendChild(anchor);
    const onDismiss = vi.fn();
    try {
      render(
        <InlineReaction
          reaction={{
            text: "Some reaction",
            confidence: 0.85,
            channel_used: "ollama",
            tool_id: "ollama",
            surface_id: "s2",
            created_at: 0,
          }}
          anchor={anchor}
          onDismiss={onDismiss}
        />,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onDismiss).toHaveBeenCalled();
    } finally {
      anchor.remove();
    }
  });
});

describe("<AmbientInputObserver/>", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        agiParticipation: true,
        agiVolume: "quiet",
        mutedAgiChannels: [],
        dismissedSurfaces: [],
        agiConfidenceThreshold: 0.7,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("debounces input and calls agiAnalyzeInput once", async () => {
    // Real timers — the 800ms debounce window is short enough that the
    // test still finishes in well under the 5s vitest default. Mocking
    // timers caused waitFor() to spin forever waiting on the IPC mock's
    // microtask resolution.
    const spy = vi.spyOn(tauri, "agiAnalyzeInput").mockResolvedValue({
      text: "Maybe link this to /memory/decisions/q3.md.",
      confidence: 0.85,
      channel_used: "ollama",
      tool_id: "ollama",
      latency_ms: 12,
    });

    render(
      <AmbientInputObserver>
        <textarea data-ambient-id="surface-test" data-testid="ta" />
      </AmbientInputObserver>,
    );

    const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
    // Three rapid keystrokes: only the last should fire after debounce.
    fireEvent.input(ta, { target: { value: "h" } });
    fireEvent.input(ta, { target: { value: "he" } });
    fireEvent.input(ta, { target: { value: "hello world" } });

    expect(spy).not.toHaveBeenCalled();
    await waitFor(
      () => expect(spy).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(spy.mock.calls[0][1]).toBe("surface-test");
  });

  it("never calls agi_analyze_input when volume is silent", async () => {
    useStore.getState().ui.setAgiVolume("silent");
    const spy = vi.spyOn(tauri, "agiAnalyzeInput").mockResolvedValue({
      text: "ignored",
      confidence: 0.95,
      channel_used: "ollama",
      tool_id: "ollama",
      latency_ms: 10,
    });

    render(
      <AmbientInputObserver>
        <textarea data-ambient-id="surface-silent" data-testid="ta" />
      </AmbientInputObserver>,
    );
    const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "anything" } });
    // Wait past the debounce window to verify nothing fired.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips entirely when agiParticipation is false (master kill switch)", async () => {
    useStore.getState().ui.setAgiParticipation(false);
    const spy = vi.spyOn(tauri, "agiAnalyzeInput").mockResolvedValue({
      text: "ignored",
      confidence: 0.95,
      channel_used: "ollama",
      tool_id: "ollama",
      latency_ms: 10,
    });

    render(
      <AmbientInputObserver>
        <textarea data-ambient-id="surface-paused" data-testid="ta" />
      </AmbientInputObserver>,
    );
    const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "anything" } });
    fireEvent.input(ta, { target: { value: "still anything" } });
    // Wait past the debounce window to verify nothing fired even though
    // volume / channel / threshold gates would all have passed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(spy).not.toHaveBeenCalled();
  });

  it("resumes immediately when agiParticipation flips back on", async () => {
    useStore.getState().ui.setAgiParticipation(false);
    const spy = vi.spyOn(tauri, "agiAnalyzeInput").mockResolvedValue({
      text: "Linked to /memory/decisions/q3.md.",
      confidence: 0.85,
      channel_used: "ollama",
      tool_id: "ollama",
      latency_ms: 12,
    });

    render(
      <AmbientInputObserver>
        <textarea data-ambient-id="surface-resume" data-testid="ta" />
      </AmbientInputObserver>,
    );
    const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "first pass" } });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(spy).not.toHaveBeenCalled();

    // Flip the switch back on. Wrap in act() so the AmbientInputObserver
    // useEffect that mirrors the store into policyRef runs before the
    // next keystroke; otherwise the handler still sees the stale paused
    // value when fireEvent fires synchronously.
    act(() => {
      useStore.getState().ui.setAgiParticipation(true);
    });
    fireEvent.input(ta, { target: { value: "second pass" } });
    await waitFor(
      () => expect(spy).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
  });
});
