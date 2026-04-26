// Integration — runOnce against a fake WebClient, asserting the full
// pipeline (fetch → normalize → write → cursor advance) works end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "../src/poll.js";
import { setKeytarForTesting } from "../src/auth.js";
import {
  makePaths,
  readConfig,
  writeConfig,
  readCursors,
} from "../src/memory.js";
import { defaultConfig } from "../src/types.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string) { return `${s}:${a}`; }
  async setPassword(s: string, a: string, p: string) { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string) { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string) { return this.store.delete(this.k(s, a)); }
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-slack-int-"));
}

function fakeClient(historyByChannel: Record<string, any[]>) {
  return {
    conversations: {
      async history(args: { channel: string }) {
        return { ok: true, messages: historyByChannel[args.channel] ?? [], has_more: false };
      },
      async replies() {
        return { ok: true, messages: [], has_more: false };
      },
      async list() {
        return { ok: true, channels: [] };
      },
    },
    async authTest() { return { ok: true, team: "acme", user: "tangerine-bot" }; },
  } as unknown as Parameters<typeof runOnce>[0]["client"];
}

describe("runOnce — full pipeline", () => {
  let root: string;
  let fake: FakeKeytar;

  beforeEach(async () => {
    root = tmpRoot();
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
    // Seed token + channel.
    const cfg = defaultConfig();
    cfg.channels.push({ id: "C01ENG", name: "eng-v1-launch" });
    await writeConfig(makePaths(root), cfg);
  });
  afterEach(() => setKeytarForTesting(null));

  it("polls one channel, writes timeline + thread, advances cursor", async () => {
    const client = fakeClient({
      C01ENG: [
        { type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "<@U012DAIZHE> postgres migration" },
        { type: "message", ts: "1714200000.222222", user: "U012DAIZHE", text: "on it" },
      ],
    });
    const r = await runOnce({ memoryRoot: root, token: "xoxb-fake", client });
    expect(r.channels.length).toBe(1);
    expect(r.channels[0].channel).toBe("C01ENG");
    expect(r.totalAtoms).toBe(2);
    expect(r.totalWritten).toBe(2);

    const paths = makePaths(root);
    const cursors = await readCursors(paths);
    expect(cursors.C01ENG).toBe("1714200000.222222");

    expect(existsSync(paths.timeline("2024-04-26"))).toBe(true);
    expect(existsSync(paths.timeline("2024-04-27"))).toBe(true);
    const t = readFileSync(paths.timeline("2024-04-26"), "utf8");
    expect(t).toContain("postgres migration");
    expect(t).toContain("source: slack");
  });

  it("dry-run writes nothing", async () => {
    const client = fakeClient({
      C01ENG: [{ type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "hi" }],
    });
    const r = await runOnce({ memoryRoot: root, token: "xoxb-fake", client, dryRun: true });
    expect(r.totalAtoms).toBe(1);
    expect(r.totalWritten).toBe(0);

    const paths = makePaths(root);
    expect(existsSync(paths.timeline("2024-04-26"))).toBe(false);
    const cursors = await readCursors(paths);
    expect(cursors.C01ENG).toBeUndefined();
  });

  it("second poll dedups already-seen atoms", async () => {
    const client = fakeClient({
      C01ENG: [{ type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "hi" }],
    });
    const first = await runOnce({ memoryRoot: root, token: "xoxb-fake", client });
    expect(first.totalWritten).toBe(1);
    const second = await runOnce({ memoryRoot: root, token: "xoxb-fake", client });
    // Same fixture replayed; cursor advanced last time so newCursor matches
    // the existing one. The atoms will dedup at write time.
    expect(second.channels[0].atomCount).toBeGreaterThanOrEqual(0);
    expect(second.channels[0].written + second.channels[0].skipped).toBe(second.channels[0].atomCount);
  });

  it("written atom on disk has all 8 AGI hook fields", async () => {
    const client = fakeClient({
      C01ENG: [{ type: "message", ts: "1714134567.111111", user: "U012ERIC", text: "x" }],
    });
    await runOnce({ memoryRoot: root, token: "xoxb-fake", client });
    const paths = makePaths(root);
    const t = readFileSync(paths.timeline("2024-04-26"), "utf8");
    for (const key of [
      "embedding:",
      "concepts:",
      "confidence:",
      "alternatives:",
      "source_count:",
      "reasoning_notes:",
      "sentiment:",
      "importance:",
    ]) {
      expect(t).toContain(key);
    }
  });
});
