import { describe, it, expect } from "vitest";
import { formatRelative } from "../src/components/SyncStatusIndicator";

describe("formatRelative", () => {
  it("returns 'just now' for fresh timestamps", () => {
    const iso = new Date(Date.now() - 5_000).toISOString();
    expect(formatRelative(iso)).toBe("just now");
  });

  it("rounds to minutes", () => {
    const iso = new Date(Date.now() - 4 * 60_000).toISOString();
    expect(formatRelative(iso)).toBe("4 min ago");
  });

  it("rounds to hours", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(formatRelative(iso)).toBe("3 hr ago");
  });

  it("rounds to days for old timestamps", () => {
    const iso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelative(iso)).toBe("2 d ago");
  });

  it("falls back gracefully on garbage input", () => {
    expect(formatRelative("not-a-date")).toBe("recently");
  });
});
