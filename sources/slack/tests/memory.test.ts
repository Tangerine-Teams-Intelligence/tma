// Memory writer: timeline + thread file emission, dedup, identity learning,
// AGI-hook fields serialization.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePaths,
  writeAtom,
  writeAtoms,
  readConfig,
  writeConfig,
  readCursors,
  writeCursors,
  readIdentity,
  writeIdentity,
  learnIdentities,
  atomToMarkdown,
  utcDate,
} from "../src/memory.js";
import { defaultConfig, defaultAgi, type Atom } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-slack-mem-"));
}

function fakeAtom(overrides: Partial<Atom> = {}): Atom {
  return {
    id: "evt-slack-c01eng-msg-1714134567-123456",
    ts: "2024-04-26T12:29:27.000Z",
    source: "slack",
    actor: "eric",
    actors: ["eric", "daizhe"],
    kind: "comment",
    refs: {
      slack: {
        channel: "C01ENG",
        channel_name: "eng-v1-launch",
        message_ts: "1714134567.123456",
        thread_ts: "1714134567.123456",
        url: "https://acme.slack.com/archives/C01ENG/p1714134567123456",
      },
      meeting: null,
      decisions: [],
      people: ["eric", "daizhe"],
      projects: ["v1-launch"],
      threads: ["slack-c01eng-1714134567-123456"],
    },
    status: "active",
    sample: false,
    body: "**eric** posted in #eng-v1-launch:\n\n> Heads up @daizhe — postgres migration",
    agi: defaultAgi(),
    ...overrides,
  };
}

describe("atomToMarkdown", () => {
  it("renders required frontmatter keys", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("id: evt-slack-c01eng-msg-1714134567-123456");
    expect(md).toContain("source: slack");
    expect(md).toContain("kind: comment");
    expect(md).toContain("actor: eric");
    expect(md).toContain("actors: [eric, daizhe]");
    expect(md).toContain("status: active");
    expect(md).toContain("sample: false");
    expect(md).toContain("**eric** posted in");
  });
  it("emits null literal for meeting when unset", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("meeting: null");
  });
  it("emits all 8 AGI hook fields", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("embedding: null");
    expect(md).toContain("concepts: []");
    expect(md).toContain("confidence: 1");
    expect(md).toContain("alternatives: []");
    expect(md).toContain("source_count: 1");
    expect(md).toContain("reasoning_notes: null");
    expect(md).toContain("sentiment: null");
    expect(md).toContain("importance: null");
  });
  it("serializes a non-null importance", () => {
    const md = atomToMarkdown(fakeAtom({ agi: { ...defaultAgi(), importance: 0.85 } }));
    expect(md).toContain("importance: 0.85");
  });
  it("renders slack subref correctly", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("slack:");
    expect(md).toContain("channel: C01ENG");
    expect(md).toContain("message_ts: ");
    expect(md).toContain("thread_ts: ");
  });
});

describe("utcDate", () => {
  it("extracts YYYY-MM-DD prefix", () => {
    expect(utcDate("2024-04-26T09:30:00.000Z")).toBe("2024-04-26");
  });
});

describe("config IO", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns defaults when no file exists", async () => {
    const c = await readConfig(makePaths(root));
    expect(c).toEqual(defaultConfig());
  });
  it("round-trips through writeConfig", async () => {
    const paths = makePaths(root);
    const c = defaultConfig();
    c.channels.push({ id: "C01ENG", name: "eng", projects: ["x"] });
    await writeConfig(paths, c);
    const read = await readConfig(paths);
    expect(read.channels).toHaveLength(1);
    expect(read.channels[0].id).toBe("C01ENG");
  });
});

describe("cursor IO", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns {} when missing", async () => {
    expect(await readCursors(makePaths(root))).toEqual({});
  });
  it("round-trips", async () => {
    const paths = makePaths(root);
    await writeCursors(paths, { C01ENG: "1714134567.123456" });
    const read = await readCursors(paths);
    expect(read.C01ENG).toBe("1714134567.123456");
  });
});

describe("identity IO + learning", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns empty map when missing", async () => {
    expect(await readIdentity(makePaths(root))).toEqual({});
  });
  it("self-maps unseen ids", async () => {
    const paths = makePaths(root);
    await writeIdentity(paths, { U012ERIC: "eric" });
    const out = await learnIdentities(paths, ["U012ERIC", "U999NEW", "U999NEW"]);
    expect(out.U012ERIC).toBe("eric");
    expect(out.U999NEW).toBe("U999NEW");
    const persisted = await readIdentity(paths);
    expect(persisted.U999NEW).toBe("U999NEW");
  });
});

describe("writeAtom — timeline + thread", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("writes to both timeline and thread files", async () => {
    const paths = makePaths(root);
    const r = await writeAtom(paths, fakeAtom());
    expect(r.wroteTimeline).toBe(true);
    expect(r.wroteThreadFiles).toBe(1);
    const t = readFileSync(paths.timeline("2024-04-26"), "utf8");
    const th = readFileSync(paths.thread("slack-c01eng-1714134567-123456"), "utf8");
    expect(t).toContain("evt-slack-c01eng-msg-1714134567-123456");
    expect(th).toContain("evt-slack-c01eng-msg-1714134567-123456");
  });
  it("is idempotent — second write is a no-op", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    const r2 = await writeAtom(paths, fakeAtom());
    expect(r2.wroteTimeline).toBe(false);
    expect(r2.wroteThreadFiles).toBe(0);
    const t = readFileSync(paths.timeline("2024-04-26"), "utf8");
    const occurrences = (t.match(/evt-slack-c01eng-msg-1714134567-123456/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
  it("groups by ts UTC date", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    await writeAtom(paths, fakeAtom({
      id: "evt-slack-c01eng-msg-x",
      ts: "2024-04-27T01:00:00.000Z",
      refs: { ...fakeAtom().refs, threads: ["slack-c01eng-other"] },
    }));
    expect(existsSync(paths.timeline("2024-04-26"))).toBe(true);
    expect(existsSync(paths.timeline("2024-04-27"))).toBe(true);
  });
});

describe("writeAtoms batch", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("counts written vs skipped (dedup)", async () => {
    const paths = makePaths(root);
    const a1 = fakeAtom();
    const a2 = fakeAtom({ id: "evt-2", ts: "2024-04-26T12:30:00.000Z" });
    const first = await writeAtoms(paths, [a1, a2]);
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);
    const second = await writeAtoms(paths, [a1, a2]);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
