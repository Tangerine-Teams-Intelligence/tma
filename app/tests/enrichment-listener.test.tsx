/**
 * v1.9.0 P4-A — Stage 2 LLM enrichment frontend tests.
 *
 * Covers:
 *   1. `updateSuggestion(matchId, body)` replaces the body of a banner /
 *      modal / toast in place when `match_id` matches.
 *   2. The `template_match_enriched` listener (mirrored verbatim from
 *      `AppShell.tsx`) calls `updateSuggestion` with the rule emit's
 *      `match_id` so the existing surface gets enriched.
 *   3. Silent no-op when no entry matches (user dismissed before
 *      enrichment landed).
 *
 * Same harness pattern as `template-listener.test.tsx`: render a tiny
 * mirror of the production listener body so vitest can fire payloads
 * synchronously without spinning up the Tauri bridge.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, act } from "@testing-library/react";

import { useStore } from "../src/lib/store";
import type { BannerProps } from "../src/components/suggestions/Banner";
import type { ModalProps } from "../src/components/suggestions/Modal";

/** Mirrors the AppShell-local `TemplateMatchPayload` (v1.9.0 P4-A
 *  shape with `match_id`). */
interface TemplateMatchPayload {
  match_id: string;
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

/** Mirror of the AppShell `template_match_enriched` listener body. The
 *  production version awaits `@tauri-apps/api/event::listen`; we collapse
 *  to a fireRef ref so vitest can dispatch payloads synchronously. */
function EnrichmentHarness({
  fireRef,
}: {
  fireRef: { current: ((p: TemplateMatchPayload) => void) | null };
}) {
  useEffect(() => {
    fireRef.current = (p: TemplateMatchPayload) => {
      // Mirrors AppShell.tsx's enrichment listener body. Update both
      // when the production marker block changes.
      if (!p.match_id) return;
      const ui = useStore.getState().ui;
      ui.updateSuggestion(p.match_id, p.body);
    };
    return () => {
      fireRef.current = null;
    };
  }, [fireRef]);
  return null;
}

beforeEach(() => {
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      bannerStack: [],
      modalQueue: [],
      modalsShownThisSession: 0,
      toasts: [],
    },
  }));
});

describe("updateSuggestion — store-level body swap", () => {
  it("replaces body in bannerStack when match_id matches", () => {
    const banner: BannerProps = {
      id: "banner-1",
      body: "rule body",
      match_id: "abc-123",
    };
    useStore.getState().ui.pushBanner(banner);

    expect(useStore.getState().ui.bannerStack).toHaveLength(1);
    expect(useStore.getState().ui.bannerStack[0].body).toBe("rule body");

    useStore.getState().ui.updateSuggestion("abc-123", "enriched body");

    const updated = useStore.getState().ui.bannerStack[0];
    expect(updated.body).toBe("enriched body");
    expect(updated.enriched).toBe(true);
    // id and match_id are stable across the swap.
    expect(updated.id).toBe("banner-1");
    expect(updated.match_id).toBe("abc-123");
  });

  it("replaces body in modalQueue when match_id matches", () => {
    const modal: ModalProps = {
      id: "modal-1",
      title: "Confirm",
      body: "rule body",
      confirmLabel: "OK",
      onCancel: () => {},
      onConfirm: () => {},
      match_id: "xyz-789",
    };
    useStore.getState().ui.pushModal(modal);

    useStore.getState().ui.updateSuggestion("xyz-789", "enriched body");

    const updated = useStore.getState().ui.modalQueue[0];
    expect(updated.body).toBe("enriched body");
    expect(updated.enriched).toBe(true);
  });

  it("replaces msg + text in toast when match_id matches", () => {
    useStore.getState().ui.pushToast({
      kind: "suggestion",
      msg: "rule body",
      template: "deadline_approaching",
      match_id: "toast-match",
    });

    useStore.getState().ui.updateSuggestion("toast-match", "enriched body");

    const updated = useStore.getState().ui.toasts[0];
    expect(updated.msg).toBe("enriched body");
    expect(updated.text).toBe("enriched body");
    expect(updated.enriched).toBe(true);
  });

  it("silent no-op when no entry matches (already dismissed)", () => {
    // No suggestions in any surface — should not throw.
    expect(() =>
      useStore.getState().ui.updateSuggestion("unknown-id", "body"),
    ).not.toThrow();
    expect(useStore.getState().ui.bannerStack).toHaveLength(0);
    expect(useStore.getState().ui.toasts).toHaveLength(0);
  });

  it("only updates the matching entry — other suggestions untouched", () => {
    useStore.getState().ui.pushBanner({
      id: "b1",
      body: "first",
      match_id: "id-1",
    });
    useStore.getState().ui.pushBanner({
      id: "b2",
      body: "second",
      match_id: "id-2",
    });

    useStore.getState().ui.updateSuggestion("id-1", "first enriched");

    const stack = useStore.getState().ui.bannerStack;
    expect(stack).toHaveLength(2);
    const a = stack.find((b) => b.id === "b1")!;
    const b = stack.find((b) => b.id === "b2")!;
    expect(a.body).toBe("first enriched");
    expect(a.enriched).toBe(true);
    expect(b.body).toBe("second");
    expect(b.enriched).toBeUndefined();
  });
});

describe("template_match_enriched listener — Banner UI update", () => {
  it("dispatching template_match_enriched updates banner body", () => {
    // Seed a banner with a known match_id.
    useStore.getState().ui.pushBanner({
      id: "ban-1",
      body: "**Patent RFP** is due in 12h.",
      match_id: "match-A",
    });
    expect(useStore.getState().ui.bannerStack[0].body).toContain("12h");

    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<EnrichmentHarness fireRef={ref} />);
    expect(ref.current).not.toBeNull();

    act(() => {
      ref.current!({
        match_id: "match-A",
        template: "deadline_approaching",
        body: "**Patent RFP** is due in 12h. Attorney RFPs need 3-day turnaround per [decisions/patent-rfp.md].",
        confidence: 0.95,
        atom_refs: ["decisions/patent-rfp.md"],
        surface_id: null,
        priority: 8,
        is_irreversible: false,
        is_completion_signal: false,
        is_cross_route: false,
      });
    });

    const updated = useStore.getState().ui.bannerStack[0];
    expect(updated.body).toContain("Attorney RFPs need 3-day turnaround");
    expect(updated.body).toContain("[decisions/patent-rfp.md]");
    expect(updated.enriched).toBe(true);
  });

  it("dropped enrichment (empty match_id) is a no-op", () => {
    useStore.getState().ui.pushBanner({
      id: "ban-2",
      body: "rule body",
      match_id: "match-B",
    });
    const ref = { current: null as null | ((p: TemplateMatchPayload) => void) };
    render(<EnrichmentHarness fireRef={ref} />);

    act(() => {
      ref.current!({
        match_id: "",
        template: "deadline_approaching",
        body: "this never lands",
        confidence: 0.95,
        atom_refs: [],
        surface_id: null,
        priority: 8,
        is_irreversible: false,
        is_completion_signal: false,
        is_cross_route: false,
      });
    });

    expect(useStore.getState().ui.bannerStack[0].body).toBe("rule body");
  });
});
