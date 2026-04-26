// Client wrapper smoke + rate-limit math.
import { describe, it, expect } from "vitest";
import { makeClient, readRateLimit, rateLimitBackoffMs } from "../src/client.js";

describe("makeClient", () => {
  it("constructs an octokit instance with paginate + rest", () => {
    const c = makeClient("ghp_test");
    expect(typeof c.request).toBe("function");
    expect(typeof c.paginate).toBe("function");
    expect(c.rest.pulls.list).toBeTypeOf("function");
    expect(c.rest.issues.listForRepo).toBeTypeOf("function");
    expect(c.rest.issues.listCommentsForRepo).toBeTypeOf("function");
  });
});

describe("readRateLimit", () => {
  it("parses known headers", () => {
    const r = readRateLimit({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1714000000",
    });
    expect(r).toEqual({ limit: 5000, remaining: 4999, resetUnix: 1714000000 });
  });
  it("returns null for missing", () => {
    expect(readRateLimit({})).toEqual({ limit: null, remaining: null, resetUnix: null });
  });
});

describe("rateLimitBackoffMs", () => {
  it("returns 0 with budget", () => {
    expect(rateLimitBackoffMs(4000, 9999999999, Date.now())).toBe(0);
  });
  it("returns 0 when remaining is null", () => {
    expect(rateLimitBackoffMs(null, null)).toBe(0);
  });
  it("returns wait time when low", () => {
    const now = Date.now();
    const reset = (now + 60_000) / 1000;
    const wait = rateLimitBackoffMs(10, reset, now);
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(60_000);
  });
  it("caps at 5 minutes", () => {
    const now = Date.now();
    const reset = (now + 60 * 60_000) / 1000; // 1 hour out
    const wait = rateLimitBackoffMs(0, reset, now);
    expect(wait).toBe(5 * 60_000);
  });
});
