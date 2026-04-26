import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  useStore.getState().ui.resetMemoryConfig();
});

describe("memoryConfig slice (v1.6.0)", () => {
  it("starts undefined so the onboarding modal fires", () => {
    expect(useStore.getState().ui.memoryConfig.mode).toBeUndefined();
  });

  it("setMemoryConfig patches without losing other fields", () => {
    useStore.getState().ui.setMemoryConfig({ mode: "team", repoUrl: "https://github.com/x/y" });
    useStore.getState().ui.setMemoryConfig({ githubLogin: "daizhe" });
    const c = useStore.getState().ui.memoryConfig;
    expect(c.mode).toBe("team");
    expect(c.repoUrl).toBe("https://github.com/x/y");
    expect(c.githubLogin).toBe("daizhe");
  });

  it("solo mode is a valid terminal state", () => {
    useStore.getState().ui.setMemoryConfig({ mode: "solo" });
    expect(useStore.getState().ui.memoryConfig.mode).toBe("solo");
  });

  it("reset clears the config back to undefined mode", () => {
    useStore.getState().ui.setMemoryConfig({ mode: "team", repoUrl: "x" });
    useStore.getState().ui.resetMemoryConfig();
    expect(useStore.getState().ui.memoryConfig.mode).toBeUndefined();
    expect(useStore.getState().ui.memoryConfig.repoUrl).toBeUndefined();
  });
});
