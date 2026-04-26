/**
 * envelope.test.ts — AGI envelope shape (Stage 1 Hook 4).
 */

import { describe, expect, it } from "vitest";
import { wrap, freshnessSecondsFromIso } from "../src/envelope.js";

describe("wrap", () => {
  it("builds the canonical envelope shape with defaults", () => {
    const env = wrap({ x: 1 });
    expect(env.data).toEqual({ x: 1 });
    expect(env.confidence).toBe(1.0);
    expect(env.freshness_seconds).toBe(0);
    expect(env.source_atoms).toEqual([]);
    expect(env.alternatives).toEqual([]);
    expect(env.reasoning_notes).toBeNull();
  });

  it("propagates source atoms and freshness", () => {
    const env = wrap("hello", {
      sourceAtoms: ["evt-2026-04-25-aaaaaaaaaa"],
      freshnessSeconds: 42,
    });
    expect(env.source_atoms).toEqual(["evt-2026-04-25-aaaaaaaaaa"]);
    expect(env.freshness_seconds).toBe(42);
    expect(env.confidence).toBe(1.0);
  });

  it("clamps negative freshness to 0", () => {
    const env = wrap(null, { freshnessSeconds: -5 });
    expect(env.freshness_seconds).toBe(0);
  });

  it("floors fractional freshness", () => {
    const env = wrap(null, { freshnessSeconds: 12.7 });
    expect(env.freshness_seconds).toBe(12);
  });

  it("allows confidence override (Stage 2 prep)", () => {
    const env = wrap("data", { confidence: 0.42 });
    expect(env.confidence).toBe(0.42);
  });

  it("allows alternatives + reasoning override (Stage 2 prep)", () => {
    const env = wrap("data", {
      alternatives: [{ b: 2 }],
      reasoningNotes: "noted",
    });
    expect(env.alternatives).toEqual([{ b: 2 }]);
    expect(env.reasoning_notes).toBe("noted");
  });

  it("has stable JSON serialisation order — Stage 2 clients depend on this", () => {
    const env = wrap({ x: 1 });
    const keys = Object.keys(env);
    expect(keys).toEqual([
      "data",
      "confidence",
      "freshness_seconds",
      "source_atoms",
      "alternatives",
      "reasoning_notes",
    ]);
  });
});

describe("freshnessSecondsFromIso", () => {
  it("returns 0 for null/empty/invalid input", () => {
    expect(freshnessSecondsFromIso(null)).toBe(0);
    expect(freshnessSecondsFromIso(undefined)).toBe(0);
    expect(freshnessSecondsFromIso("")).toBe(0);
    expect(freshnessSecondsFromIso("not a date")).toBe(0);
  });

  it("returns the elapsed seconds for a recent timestamp", () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const out = freshnessSecondsFromIso(tenSecondsAgo);
    expect(out).toBeGreaterThanOrEqual(9);
    expect(out).toBeLessThan(15);
  });

  it("never returns negative for future timestamps (clamped)", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(freshnessSecondsFromIso(future)).toBe(0);
  });
});
