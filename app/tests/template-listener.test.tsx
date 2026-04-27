/**
 * v1.9.0-beta.2 P2-C — `template_match` Tauri-event listener tests.
 *
 * Covers the integration polish that ties P2-A's 3 templates + P2-B's 3
 * templates + P2-C's 1 = 7 into a single React-side listener
 * (`AppShell.tsx` consolidated marker block):
 *
 *   * A `template_match` Tauri event triggers `pushSuggestion(...)` with
 *     the right shape (template / body / confidence / signals carried
 *     through unchanged).
 *   * The `newcomer_onboarding` template only fires once per install —
 *     the `newcomerOnboardingShown` store latch silently drops further
 *     matches even though the Rust detector is stateless.
 *   * Other templates (deadline / decision_drift / catchup_hint / …)
 *     are not affected by the newcomer latch.
 *
 * The test approach: rather than render the full AppShell (which pulls in
 * Sidebar / ActivityFeed / route Outlet plumbing irrelevant to this gate),
 * we inline the consolidated listener body as a tiny `<HarnessShell/>`
 * that mirrors the production code in `AppShell.tsx` 1:1. If the
 * production marker block evolves (e.g. additional gates inside the
 * listener), update both this harness and AppShell in lockstep — diff
 * stays small enough to spot regressions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render, act } from "@testing-library/react";

import { useStore } from "../src/lib/store";
import * as bus from "../src/lib/suggestion-bus";

/**
 * Mirrors the Rust `agi::templates::common::TemplateMatch` shape and the
 * AppShell-local `TemplateMatchPayload` type. Kept in sync with
 * `app/src/components/layout/AppShell.tsx`.
 */
interface TemplateMatchPayload {
  template: string;
  body: string;
  confidence: number;
  atom_refs: string[];
  surface_id: string | null;
  priority: number;
  is_irreversible: boolean;
  is_completion_signal: boolean;
  is_cross_route: boolean;
}

/** Build a minimal payload — used by every test. */
function payload(over: Partial<TemplateMatchPayload> = {}): TemplateMatchPayload {
  return {
    template: "deadline_approaching",
    body: "Patent attorney RFP — 2 days",
    confidence: 0.95,
    atom_refs: ["decisions/patent-rfp.md"],
    surface_id: null,
    priority: 6,
    is_irreversible: false,
    is_completion_signal: false,
    is_cross_route: false,
    ...over,
  };
}

/**
 * Test harness that mounts the consolidated listener body. Exposes a
 * `fire(p)` ref so tests can synchronously dispatch a payload through the
 * same code path the Tauri event bus would.
 *
 * The "real" implementation is a `useEffect` that awaits a dynamic import
 * of `@tauri-apps/api/event`; vitest in jsdom mode can't satisfy that
 * import, so we collapse the listener body into a function callable via
 * a ref that mirrors what AppShell.tsx does in the `(e) => { ... }` arm
 * of `listen<TemplateMatchPayload>("template_match", ...)`.
 */
function HarnessShell({
  fireRef,
}: {
  fireRef: { current: ((p: TemplateMatchPayload) => void) | null };
}) {
  useEffect(() => {
    fireRef.current = (p: TemplateMatchPayload) => {
      // Mirrors AppShell.tsx's listener body verbatim. Update in lockstep
      // when the production marker block changes.
      if (p.template === "newcomer_onboarding") {
        const ui = useStore.getState().ui;
        if (ui.newcomerOnboardingShown) return;
        ui.setNewcomerOnboardingShown(true);
      }
      void bus.pushSuggestion({
        template: p.template,
        body: p.body,
        confidence: p.confidence,
        is_irreversible: p.is_irreversible,
        is_completion_signal: p.is_completion_signal,
        is_cross_route: p.is_cross_route,
        surface_id: p.surface_id ?? undefined,
        priority: p.priority,
      });
    };
    return () => {
      fireRef.current = null;
    };
  }, [fireRef]);
  return null;
}

beforeEach(() => {
  // Reset every store slice the listener reads so tests don't leak state
  // between cases.
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
      newcomerOnboardingShown: false,
    },
  }));
});

describe("template_match listener — integration polish", () => {
  it("template_match event triggers pushSuggestion", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);
    expect(ref.current).not.toBeNull();

    act(() => {
      ref.current!(
        payload({
          template: "deadline_approaching",
          body: "Patent attorney RFP — 2 days",
          confidence: 0.95,
        }),
      );
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0][0];
    expect(call.template).toBe("deadline_approaching");
    expect(call.body).toBe("Patent attorney RFP — 2 days");
    expect(call.confidence).toBe(0.95);
    expect(call.priority).toBe(6);
    expect(call.surface_id).toBeUndefined();
  });

  it("forwards every signal flag through to the bus unchanged", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    act(() => {
      ref.current!(
        payload({
          template: "decision_drift",
          is_cross_route: true,
          confidence: 0.85,
        }),
      );
    });

    expect(spy.mock.calls[0][0]).toMatchObject({
      template: "decision_drift",
      is_cross_route: true,
      is_irreversible: false,
      is_completion_signal: false,
    });
  });

  it("converts surface_id null → undefined for chip-tier templates", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    act(() => {
      ref.current!(
        payload({
          template: "pattern_recurrence",
          surface_id: "decisions/pricing-lock.md",
          confidence: 0.8,
        }),
      );
    });

    expect(spy.mock.calls[0][0].surface_id).toBe("decisions/pricing-lock.md");
  });
});

describe("newcomer flag stops re-fire", () => {
  it("first newcomer_onboarding match flips the latch and pushes", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    expect(useStore.getState().ui.newcomerOnboardingShown).toBe(false);

    act(() => {
      ref.current!(
        payload({
          template: "newcomer_onboarding",
          body: "Welcome",
          confidence: 1.0,
          priority: 10,
        }),
      );
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useStore.getState().ui.newcomerOnboardingShown).toBe(true);
  });

  it("second newcomer_onboarding match is silently dropped", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    // First fire — latch flips, push goes through.
    act(() => {
      ref.current!(
        payload({ template: "newcomer_onboarding", confidence: 1.0, priority: 10 }),
      );
    });
    // Second fire — the heartbeat keeps emitting since the Rust detector
    // is stateless, but the listener must drop it.
    act(() => {
      ref.current!(
        payload({ template: "newcomer_onboarding", confidence: 1.0, priority: 10 }),
      );
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("latch is per-template — deadline / drift fire even after newcomer flip", () => {
    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    // Flip the latch with an initial newcomer match.
    act(() => {
      ref.current!(payload({ template: "newcomer_onboarding", priority: 10 }));
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // Now fire other templates — they must not be gated by the latch.
    act(() => {
      ref.current!(payload({ template: "deadline_approaching", priority: 8 }));
      ref.current!(
        payload({ template: "decision_drift", is_cross_route: true, priority: 9 }),
      );
      ref.current!(
        payload({ template: "catchup_hint", is_cross_route: true, priority: 10 }),
      );
    });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("a pre-flipped latch (persisted across launches) drops the very first newcomer match", () => {
    // Simulate a returning user whose latch was flipped on a previous
    // launch and persisted via the store partialize.
    useStore.getState().ui.setNewcomerOnboardingShown(true);

    const spy = vi.spyOn(bus, "pushSuggestion").mockResolvedValue();
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<HarnessShell fireRef={ref} />);

    act(() => {
      ref.current!(
        payload({ template: "newcomer_onboarding", confidence: 1.0, priority: 10 }),
      );
    });
    // Listener never reaches `pushSuggestion` because the latch is set.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("store integration — newcomer latch persistence shape", () => {
  it("setNewcomerOnboardingShown(true) is reflected on the next store read", () => {
    expect(useStore.getState().ui.newcomerOnboardingShown).toBe(false);
    useStore.getState().ui.setNewcomerOnboardingShown(true);
    expect(useStore.getState().ui.newcomerOnboardingShown).toBe(true);
  });

  it("setNewcomerOnboardingShown(false) is idempotent — flag is just a boolean", () => {
    useStore.getState().ui.setNewcomerOnboardingShown(true);
    useStore.getState().ui.setNewcomerOnboardingShown(false);
    expect(useStore.getState().ui.newcomerOnboardingShown).toBe(false);
  });
});
