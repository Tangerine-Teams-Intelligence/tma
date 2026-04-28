// === wave 9 ===
import { describe, expect, it } from "vitest";
import { vendorColor, ALL_VENDOR_IDS, VENDOR_COLORS } from "../src/lib/vendor-colors";

describe("Wave 9 — vendor-colors", () => {
  it("resolves canonical ids directly", () => {
    expect(vendorColor("cursor").hex).toBe("#00A8E8");
    expect(vendorColor("claude-code").hex).toBe("#5C2DC8");
    expect(vendorColor("chatgpt").hex).toBe("#10A37F");
    expect(vendorColor("codex").hex).toBe("#F59E0B");
  });

  it("normalizes alternate forms (underscore / spaces / case)", () => {
    expect(vendorColor("Claude Code").hex).toBe("#5C2DC8");
    expect(vendorColor("claude_code").hex).toBe("#5C2DC8");
    expect(vendorColor("CURSOR").hex).toBe("#00A8E8");
  });

  it("returns a neutral fallback for unknown ids", () => {
    const v = vendorColor("totally-unknown-vendor");
    expect(v.label).toBe("Unknown");
    expect(v.hex).toMatch(/^#/);
  });

  it("returns a neutral fallback for null/undefined", () => {
    expect(vendorColor(null).label).toBe("Unknown");
    expect(vendorColor(undefined).label).toBe("Unknown");
    expect(vendorColor("").label).toBe("Unknown");
  });

  it("apple-intelligence is a gradient, not a flat hex", () => {
    expect(VENDOR_COLORS["apple-intelligence"].hex).toContain("linear-gradient");
  });

  it("ALL_VENDOR_IDS lists every entry in VENDOR_COLORS", () => {
    const keys = new Set(Object.keys(VENDOR_COLORS));
    for (const id of ALL_VENDOR_IDS) {
      expect(keys.has(id)).toBe(true);
    }
  });

  it("every color exposes a non-empty bgTint", () => {
    for (const v of Object.values(VENDOR_COLORS)) {
      expect(typeof v.bgTint).toBe("string");
      expect(v.bgTint.length).toBeGreaterThan(0);
    }
  });
});
// === end wave 9 ===
