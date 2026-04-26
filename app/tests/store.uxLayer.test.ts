import { describe, expect, it, beforeEach } from "vitest";
import { useStore } from "../src/lib/store";

describe("Stage 1 Wave 3 store extensions", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        currentUser: "me",
        dismissedAtoms: [],
        snoozedAtoms: {},
        whatsNewDismissed: false,
      },
    }));
  });

  it("setCurrentUser updates the alias", () => {
    useStore.getState().ui.setCurrentUser("daizhe");
    expect(useStore.getState().ui.currentUser).toBe("daizhe");
  });

  it("dismissAtom appends new id only once", () => {
    useStore.getState().ui.dismissAtom("evt-2026-04-26-aaaaaaaaaa");
    useStore.getState().ui.dismissAtom("evt-2026-04-26-aaaaaaaaaa");
    expect(useStore.getState().ui.dismissedAtoms).toEqual([
      "evt-2026-04-26-aaaaaaaaaa",
    ]);
  });

  it("snoozeAtom records the until-ms", () => {
    const t = Date.now() + 24 * 60 * 60_000;
    useStore.getState().ui.snoozeAtom("evt-2026-04-26-bbbbbbbbbb", t);
    expect(useStore.getState().ui.snoozedAtoms["evt-2026-04-26-bbbbbbbbbb"]).toBe(t);
  });

  it("resetDismissals clears both lists", () => {
    useStore.getState().ui.dismissAtom("evt-2026-04-26-cccccccccc");
    useStore.getState().ui.snoozeAtom("evt-2026-04-26-dddddddddd", 99);
    useStore.getState().ui.resetDismissals();
    expect(useStore.getState().ui.dismissedAtoms).toEqual([]);
    expect(useStore.getState().ui.snoozedAtoms).toEqual({});
  });

  it("setWhatsNewDismissed flips the flag", () => {
    useStore.getState().ui.setWhatsNewDismissed(true);
    expect(useStore.getState().ui.whatsNewDismissed).toBe(true);
    useStore.getState().ui.setWhatsNewDismissed(false);
    expect(useStore.getState().ui.whatsNewDismissed).toBe(false);
  });
});
