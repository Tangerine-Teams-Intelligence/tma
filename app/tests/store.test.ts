import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  useStore.getState().wizard.reset();
});

describe("wizard slice", () => {
  it("starts at step 0 with empty collected data", () => {
    const w = useStore.getState().wizard;
    expect(w.step).toBe(0);
    expect(w.collected).toEqual({});
  });

  it("next() advances and back() rewinds within bounds", () => {
    useStore.getState().wizard.next();
    expect(useStore.getState().wizard.step).toBe(1);
    useStore.getState().wizard.next();
    expect(useStore.getState().wizard.step).toBe(2);
    useStore.getState().wizard.back();
    expect(useStore.getState().wizard.step).toBe(1);
  });

  it("does not advance past 5 or rewind below 0", () => {
    for (let i = 0; i < 10; i++) useStore.getState().wizard.next();
    expect(useStore.getState().wizard.step).toBe(5);
    for (let i = 0; i < 10; i++) useStore.getState().wizard.back();
    expect(useStore.getState().wizard.step).toBe(0);
  });

  it("setField persists collected data", () => {
    useStore.getState().wizard.setField("guildId", "abc");
    expect(useStore.getState().wizard.collected.guildId).toBe("abc");
  });
});

describe("ui slice", () => {
  it("toggleTheme flips light <-> dark", () => {
    const before = useStore.getState().ui.theme;
    useStore.getState().ui.toggleTheme();
    expect(useStore.getState().ui.theme).not.toBe(before);
  });

  it("pushToast + dismissToast roundtrips", () => {
    useStore.getState().ui.pushToast("info", "hello");
    const id = useStore.getState().ui.toasts[0]?.id;
    expect(id).toBeTruthy();
    useStore.getState().ui.dismissToast(id!);
    expect(useStore.getState().ui.toasts.length).toBe(0);
  });
});
