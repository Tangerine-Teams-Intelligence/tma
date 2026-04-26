// Normalize: Slack payloads → atoms. Loads real fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMessage,
  normalizeChannelCreated,
  normalizePin,
  makeCtx,
  extractMentions,
  projectsForChannel,
  looksLikeDecision,
  aliasFor,
  slackTsToIso,
  type RawMessage,
  type RawChannelCreated,
  type RawPin,
} from "../src/normalize.js";
import { defaultConfig, type IdentityMap } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const identity: IdentityMap = { U012ERIC: "eric", U012DAIZHE: "daizhe", U012HONGYU: "hongyu" };
const cfg = defaultConfig();
const ctx = makeCtx({ id: "C01ENG", name: "eng-v1-launch" }, identity, cfg);

describe("alias resolution", () => {
  it("maps known slack ids to tangerine aliases", () => {
    expect(aliasFor("U012ERIC", identity)).toBe("eric");
    expect(aliasFor("U012DAIZHE", identity)).toBe("daizhe");
  });
  it("returns the raw id when unknown", () => {
    expect(aliasFor("U999NEW", identity)).toBe("U999NEW");
  });
  it("returns 'unknown' for null/empty", () => {
    expect(aliasFor(null, identity)).toBe("unknown");
    expect(aliasFor(undefined, identity)).toBe("unknown");
    expect(aliasFor("", identity)).toBe("unknown");
  });
});

describe("mention extraction", () => {
  it("pulls <@U…> mentions and resolves them", () => {
    const m = extractMentions("ping <@U012ERIC> and <@U012DAIZHE>", identity);
    expect(m).toContain("eric");
    expect(m).toContain("daizhe");
    expect(m.length).toBe(2);
  });
  it("handles the |display syntax", () => {
    const m = extractMentions("hi <@U012DAIZHE|daizhe>", identity);
    expect(m).toEqual(["daizhe"]);
  });
  it("returns [] for null/empty", () => {
    expect(extractMentions(null, identity)).toEqual([]);
    expect(extractMentions("", identity)).toEqual([]);
  });
  it("dedups", () => {
    const m = extractMentions("<@U012ERIC> hi <@U012ERIC> again", identity);
    expect(m).toEqual(["eric"]);
  });
  it("ignores plain @text (not Slack format)", () => {
    expect(extractMentions("hey @daizhe how are you", identity)).toEqual([]);
  });
});

describe("project detection from channel name", () => {
  it("strips eng- prefix and surfaces the remainder", () => {
    expect(projectsForChannel("eng-v1-launch", cfg)).toEqual(["v1-launch"]);
  });
  it("strips proj- prefix", () => {
    expect(projectsForChannel("proj-postgres-migration", cfg)).toEqual(["postgres-migration"]);
  });
  it("returns [] when no recognized prefix", () => {
    expect(projectsForChannel("random", cfg)).toEqual([]);
  });
  it("returns [] for undefined/empty", () => {
    expect(projectsForChannel(undefined, cfg)).toEqual([]);
    expect(projectsForChannel("", cfg)).toEqual([]);
  });
});

describe("decision sniffer", () => {
  it("flags clear decision verbs", () => {
    expect(looksLikeDecision("we decided to use Postgres")).toBe(true);
    expect(looksLikeDecision("agreed — going with rust")).toBe(true);
    expect(looksLikeDecision("we'll go with the partition strategy")).toBe(true);
    expect(looksLikeDecision("Let's go with yaml")).toBe(true);
    expect(looksLikeDecision("Conclusion: ship it")).toBe(true);
  });
  it("does not flag idle chatter", () => {
    expect(looksLikeDecision("I think we should ship it")).toBe(false);
    expect(looksLikeDecision("any thoughts on this?")).toBe(false);
    expect(looksLikeDecision(null)).toBe(false);
    expect(looksLikeDecision("")).toBe(false);
  });
});

describe("slackTsToIso", () => {
  it("converts a Slack ts to RFC 3339 UTC", () => {
    expect(slackTsToIso("1714134567.123456")).toBe("2024-04-26T12:29:27.000Z");
  });
  it("falls back to a Date for empty input", () => {
    const fallback = new Date("2026-04-25T00:00:00Z");
    expect(slackTsToIso(null, fallback)).toBe("2026-04-25T00:00:00.000Z");
  });
});

describe("normalizeMessage (top-level)", () => {
  const raw = fixtures("message_top_level.json") as RawMessage;
  const a = normalizeMessage(raw, ctx);

  it("emits the right id, kind, source", () => {
    expect(a.id).toBe("evt-slack-c01eng-msg-1714134567-123456");
    expect(a.kind).toBe("comment");
    expect(a.source).toBe("slack");
  });
  it("normalizes ts to UTC RFC 3339", () => {
    expect(a.ts).toBe("2024-04-26T12:29:27.000Z");
  });
  it("resolves the actor alias", () => {
    expect(a.actor).toBe("eric");
  });
  it("includes mentioned actors", () => {
    expect(a.actors).toContain("eric");
    expect(a.actors).toContain("daizhe");
  });
  it("attaches slack refs", () => {
    expect(a.refs.slack?.channel).toBe("C01ENG");
    expect(a.refs.slack?.channel_name).toBe("eng-v1-launch");
    expect(a.refs.slack?.message_ts).toBe("1714134567.123456");
    expect(a.refs.slack?.thread_ts).toBe("1714134567.123456");
  });
  it("derives project from channel name", () => {
    expect(a.refs.projects).toEqual(["v1-launch"]);
  });
  it("creates the per-thread id", () => {
    expect(a.refs.threads).toEqual(["slack-c01eng-1714134567-123456"]);
  });
  it("body opens with the actor", () => {
    expect(a.body).toContain("**eric** posted in #eng-v1-launch");
    expect(a.body).toContain("Original at: https://acme.slack.com");
  });
  it("emits all 8 AGI hook fields with defaults", () => {
    expect(a.agi.embedding).toBeNull();
    expect(a.agi.concepts).toEqual([]);
    expect(a.agi.confidence).toBe(1.0);
    expect(a.agi.alternatives).toEqual([]);
    expect(a.agi.source_count).toBe(1);
    expect(a.agi.reasoning_notes).toBeNull();
    expect(a.agi.sentiment).toBeNull();
    expect(a.agi.importance).toBeNull();
  });
});

describe("normalizeMessage (thread reply)", () => {
  const raw = fixtures("message_thread_reply.json") as RawMessage;
  const a = normalizeMessage(raw, ctx);

  it("ts != thread_ts so kind=comment + 'replied in' phrasing", () => {
    expect(a.kind).toBe("comment");
    expect(a.body).toContain("**daizhe** replied in #eng-v1-launch");
  });
  it("thread id derives from thread_ts (so root + replies share thread)", () => {
    expect(a.refs.threads).toEqual(["slack-c01eng-1714134567-123456"]);
  });
});

describe("normalizeMessage (decision sniff upgrades kind)", () => {
  const raw = fixtures("message_decision.json") as RawMessage;
  const a = normalizeMessage(raw, ctx);
  it("kind upgraded to decision", () => {
    expect(a.kind).toBe("decision");
  });
  it("body still includes the decision text", () => {
    expect(a.body).toContain("decided to go with");
  });
});

describe("normalizeMessage (with importance override from ⭐)", () => {
  it("respects context-level importance override", () => {
    const raw = fixtures("message_with_star.json") as RawMessage;
    const ctxStarred = { ...ctx, importanceOverride: 0.75 };
    const a = normalizeMessage(raw, ctxStarred);
    expect(a.agi.importance).toBe(0.75);
  });
  it("default ctx leaves importance null", () => {
    const raw = fixtures("message_with_star.json") as RawMessage;
    const a = normalizeMessage(raw, ctx);
    expect(a.agi.importance).toBeNull();
  });
});

describe("normalizeChannelCreated", () => {
  const raw = fixtures("channel_created.json") as RawChannelCreated;
  const a = normalizeChannelCreated(raw, ctx);
  it("kind = system, ts derived from epoch", () => {
    expect(a.kind).toBe("system");
    expect(a.ts).toBe("2024-04-26T12:20:00.000Z");
  });
  it("actor is the creator", () => {
    expect(a.actor).toBe("daizhe");
  });
  it("channel name surfaces in body", () => {
    expect(a.body).toContain("Channel **#eng-v2-launch**");
  });
  it("derives project from channel name", () => {
    expect(a.refs.projects).toEqual(["v2-launch"]);
  });
  it("threads carries a channel-scoped meta thread", () => {
    expect(a.refs.threads).toEqual(["slack-c02new-channel"]);
  });
  it("emits all 8 AGI hook fields with defaults", () => {
    expect(a.agi.confidence).toBe(1.0);
    expect(a.agi.source_count).toBe(1);
  });
});

describe("normalizePin", () => {
  const msg = fixtures("message_pinned.json") as RawMessage;
  const raw: RawPin = {
    pinned_ts: "1714161000.000000",
    pinned_by: "U012ERIC",
    message: msg,
  };
  const a = normalizePin(raw, ctx);

  it("kind = decision", () => {
    expect(a.kind).toBe("decision");
  });
  it("actor = pinner", () => {
    expect(a.actor).toBe("eric");
  });
  it("actors include both pinner and author", () => {
    expect(a.actors).toContain("eric");
    expect(a.actors).toContain("daizhe");
  });
  it("body shows pinned content + permalink", () => {
    expect(a.body).toContain("**eric** pinned a message by **daizhe**");
    expect(a.body).toContain("> Decided: launch is May 1");
  });
  it("importance is 0.85", () => {
    expect(a.agi.importance).toBe(0.85);
  });
  it("thread shared with the original message", () => {
    expect(a.refs.threads).toEqual(["slack-c01eng-1714160000-333333"]);
  });
});
