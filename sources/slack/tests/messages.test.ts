// Ingest — channel messages. Mocks @slack/web-api at the WebClient method level.

import { describe, it, expect } from "vitest";
import { ingestMessages } from "../src/ingest/messages.js";
import { makeCtx } from "../src/normalize.js";
import { defaultConfig, type ChannelConfig, type IdentityMap } from "../src/types.js";

const identity: IdentityMap = { U012ERIC: "eric", U012DAIZHE: "daizhe" };
const cfg = defaultConfig();
const channel: ChannelConfig = { id: "C01ENG", name: "eng-v1-launch" };
const ctx = makeCtx({ id: "C01ENG", name: "eng-v1-launch" }, identity, cfg);

interface SlackMessageItem {
  type?: string;
  subtype?: string | null;
  ts: string;
  user?: string | null;
  text?: string | null;
  thread_ts?: string | null;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
  pinned_to?: string[];
}

function fakeClient(opts: {
  history: SlackMessageItem[];
  replies?: Record<string, SlackMessageItem[]>;
  failHistory?: boolean;
}) {
  const replies = opts.replies ?? {};
  return {
    conversations: {
      async history() {
        if (opts.failHistory) {
          return { ok: false, error: "rate_limited" };
        }
        return { ok: true, messages: opts.history, has_more: false };
      },
      async replies(args: { channel: string; ts: string }) {
        const m = replies[args.ts] ?? [];
        return { ok: true, messages: m, has_more: false };
      },
    },
  } as unknown as Parameters<typeof ingestMessages>[0];
}

describe("ingestMessages — basic flow", () => {
  it("emits one atom per top-level message", async () => {
    const client = fakeClient({
      history: [
        { type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "hi <@U012DAIZHE>" },
        { type: "message", ts: "1714134600.222222", user: "U012DAIZHE", text: "ok" },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.atoms.length).toBe(2);
    expect(r.atoms[0].kind).toBe("comment");
    expect(r.atoms[0].source).toBe("slack");
  });

  it("collects raw user ids for identity learning", async () => {
    const client = fakeClient({
      history: [
        { type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "x" },
        { type: "message", ts: "1714134600.222222", user: "U999NEW", text: "y" },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.rawUserIds.has("U012ERIC")).toBe(true);
    expect(r.rawUserIds.has("U999NEW")).toBe(true);
  });

  it("advances cursor to the newest ts", async () => {
    const client = fakeClient({
      history: [
        { type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "x" },
        { type: "message", ts: "1714200000.999999", user: "U012DAIZHE", text: "y" },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.newCursor).toBe("1714200000.999999");
  });

  it("respects existing cursor when no newer messages", async () => {
    const client = fakeClient({ history: [] });
    const r = await ingestMessages(client, channel, ctx, "1714000000.000000");
    expect(r.newCursor).toBe("1714000000.000000");
    expect(r.atoms).toEqual([]);
  });

  it("ignores channel_join subtypes", async () => {
    const client = fakeClient({
      history: [
        { type: "message", subtype: "channel_join", ts: "1714134567.111111", user: "U012ALICE", text: "<@U012ALICE> has joined" },
        { type: "message", ts: "1714134600.222222", user: "U012ERIC", text: "real msg" },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.atoms.length).toBe(1);
    expect(r.atoms[0].body).toContain("real msg");
  });

  it("fetches replies when reply_count > 0 and emits atoms for each", async () => {
    const client = fakeClient({
      history: [
        {
          type: "message",
          ts: "1714134567.111111",
          user: "U012ERIC",
          text: "starting thread",
          thread_ts: "1714134567.111111",
          reply_count: 2,
        },
      ],
      replies: {
        "1714134567.111111": [
          { type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "starting thread" }, // root, dedup'd
          { type: "message", ts: "1714135000.222222", user: "U012DAIZHE", text: "reply 1", thread_ts: "1714134567.111111" },
          { type: "message", ts: "1714136000.333333", user: "U012ERIC", text: "reply 2", thread_ts: "1714134567.111111" },
        ],
      },
    });
    const r = await ingestMessages(client, channel, ctx, null);
    // 1 root + 2 replies (root in replies is filtered out)
    expect(r.atoms.length).toBe(3);
    const replyBodies = r.atoms.map((a) => a.body).join("\n");
    expect(replyBodies).toContain("reply 1");
    expect(replyBodies).toContain("reply 2");
  });

  it("emits a pin atom when message is pinned to this channel", async () => {
    const client = fakeClient({
      history: [
        {
          type: "message",
          ts: "1714134567.111111",
          user: "U012DAIZHE",
          text: "Decided: go with v2",
          thread_ts: "1714134567.111111",
          pinned_to: ["C01ENG"],
        },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    // 1 message atom + 1 pin atom (decision)
    expect(r.atoms.length).toBe(2);
    const kinds = r.atoms.map((a) => a.kind).sort();
    expect(kinds).toEqual(["decision", "decision"]); // message decision-sniffed + pin
    const pin = r.atoms.find((a) => a.id.includes("pin-"));
    expect(pin).toBeDefined();
    expect(pin!.agi.importance).toBe(0.85);
  });

  it("⭐ reaction bumps importance on the message atom", async () => {
    const client = fakeClient({
      history: [
        {
          type: "message",
          ts: "1714134567.111111",
          user: "U012ERIC",
          text: "starred message",
          reactions: [{ name: "star", count: 1, users: ["U012DAIZHE"] }],
        },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.atoms[0].agi.importance).toBe(0.75);
  });

  it("non-star reactions do NOT bump importance", async () => {
    const client = fakeClient({
      history: [
        {
          type: "message",
          ts: "1714134567.111111",
          user: "U012ERIC",
          text: "regular message",
          reactions: [{ name: "+1", count: 5 }],
        },
      ],
    });
    const r = await ingestMessages(client, channel, ctx, null);
    expect(r.atoms[0].agi.importance).toBeNull();
  });

  it("throws on history failure", async () => {
    const client = fakeClient({ history: [], failHistory: true });
    await expect(ingestMessages(client, channel, ctx, null)).rejects.toThrow("rate_limited");
  });
});
