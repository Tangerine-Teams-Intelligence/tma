// === wave 1.13-A ===
import { describe, expect, it } from "vitest";
import { extractMentions } from "../src/lib/mention-extract";

describe("extractMentions (wave 1.13-A)", () => {
  it("returns the alias of a single @mention", () => {
    expect(extractMentions("hey @alice take a look")).toEqual(["alice"]);
  });

  it("lowercases aliases", () => {
    expect(extractMentions("Hey @Alice")).toEqual(["alice"]);
  });

  it("skips email addresses", () => {
    expect(extractMentions("ping me at daizhe@berkeley.edu")).toEqual([]);
  });

  it("dedupes repeated mentions of the same user", () => {
    expect(
      extractMentions("@alice please review and @alice also confirm"),
    ).toEqual(["alice"]);
  });

  it("returns multiple distinct aliases in first-occurrence order", () => {
    expect(extractMentions("@bob and @alice and @bob again")).toEqual([
      "bob",
      "alice",
    ]);
  });

  it("ignores @mentions inside fenced code blocks", () => {
    const md = "before\n```\n@alice not-a-mention\n```\nafter @bob real";
    expect(extractMentions(md)).toEqual(["bob"]);
  });

  it("ignores @mentions inside inline code", () => {
    expect(extractMentions("see `@alice` here, but @bob is real")).toEqual([
      "bob",
    ]);
  });

  it("returns [] for empty / null-ish input", () => {
    expect(extractMentions("")).toEqual([]);
    // @ts-expect-error — defensive call shape
    expect(extractMentions(undefined)).toEqual([]);
  });
});
// === end wave 1.13-A ===
