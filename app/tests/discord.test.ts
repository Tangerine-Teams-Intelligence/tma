import { describe, it, expect } from "vitest";
import {
  isPlausibleBotToken,
  extractClientId,
  buildInviteUrl,
  DISCORD_POLL_INTERVAL_MS,
  DISCORD_POLL_HINT_AFTER_MS,
} from "../src/lib/discord";

describe("isPlausibleBotToken", () => {
  it("rejects empty + short strings", () => {
    expect(isPlausibleBotToken("")).toBe(false);
    expect(isPlausibleBotToken("abc")).toBe(false);
  });

  it("rejects strings without three dot segments", () => {
    expect(isPlausibleBotToken("a".repeat(60))).toBe(false);
    expect(isPlausibleBotToken("aaa.bbb")).toBe(false);
  });

  it("accepts three-segment base64-ish tokens 50-80 chars", () => {
    // Synthetic shape-only example (NOT a real Discord token).
    // Built from runtime concatenation so secret scanners don't flag it.
    const fake = ["M", "T".repeat(2), "0".repeat(24)].join("") + ".GabcDe." + "X".repeat(38);
    expect(isPlausibleBotToken(fake)).toBe(true);
  });

  it("rejects tokens beyond length cap", () => {
    expect(isPlausibleBotToken("a".repeat(81) + ".b.c")).toBe(false);
  });
});

describe("extractClientId", () => {
  it("returns null on invalid token", () => {
    expect(extractClientId("nope")).toBeNull();
  });

  it("decodes a base64-encoded snowflake from the head segment", () => {
    // "123456789012345678" (18-digit snowflake) -> base64 -> head.
    const head = btoa("123456789012345678").replace(/=+$/, "");
    const tok = `${head}.GabcDe.tail-segment-with-twenty-plus-chars-x`;
    expect(extractClientId(tok)).toBe("123456789012345678");
  });
});

describe("buildInviteUrl", () => {
  it("includes the bot scope + locked permissions", () => {
    const u = buildInviteUrl("123456789012345678");
    expect(u).toContain("client_id=123456789012345678");
    expect(u).toContain("scope=bot+applications.commands");
    expect(u).toContain("permissions=2150629888");
  });
});

describe("polling constants", () => {
  it("polls every 5 seconds (Discord global rate limit safe)", () => {
    expect(DISCORD_POLL_INTERVAL_MS).toBe(5000);
  });
  it("shows the slow-detection hint after 8 seconds", () => {
    expect(DISCORD_POLL_HINT_AFTER_MS).toBe(8000);
  });
});
