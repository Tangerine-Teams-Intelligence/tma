// Memory writer + AGI-hook serialization tests.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "tg-cal-mem-"));
}

function fakeAtom(overrides: Partial<Atom> = {}): Atom {
  return {
    id: "evt-cal-ical-acme-2026-04-15-postgres-migration-sync-tangerin",
    ts: "2026-04-15T14:00:00.000Z",
    source: "calendar",
    actor: "eric",
    actors: ["eric", "daizhe", "hongyu"],
    kind: "calendar_event",
    refs: {
      calendar: {
        provider: "ical",
        calendar: "ical-acme",
        uid: "past-event-001@tangerine.test",
        slug: "2026-04-15-postgres-migration-sync-tangerin",
        start: "2026-04-15T14:00:00.000Z",
        end: "2026-04-15T15:00:00.000Z",
        title: "[v1-launch] Postgres migration sync",
        location: "Zoom",
      },
      meeting: null,
      decisions: [],
      people: ["eric", "daizhe", "hongyu"],
      projects: ["v1-launch"],
      threads: ["cal-ical-acme-2026-04-15-postgres-migration-sync-tangerin"],
      meetings: ["2026-04-15-postgres-migration-sync-tangerin"],
    },
    status: "active",
    sample: false,
    body: "**[v1-launch] Postgres migration sync**",
    agi: defaultAgi(),
    ...overrides,
  };
}

describe("atomToMarkdown", () => {
  it("renders required frontmatter keys", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("source: calendar");
    expect(md).toContain("kind: calendar_event");
    expect(md).toContain("actor: eric");
    expect(md).toContain("status: active");
    expect(md).toContain("sample: false");
  });
  it("renders calendar subref correctly", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("calendar:");
    expect(md).toContain("provider: ical");
    expect(md).toContain("uid: ");
    expect(md).toContain("slug: ");
    expect(md).toContain("start: ");
    expect(md).toContain("end: ");
    expect(md).toContain("location: Zoom");
  });
  it("renders meetings ref when present", () => {
    const md = atomToMarkdown(fakeAtom());
    expect(md).toContain("meetings:");
  });
  it("emits all 8 AGI hook fields", () => {
    const md = atomToMarkdown(fakeAtom());
    for (const key of [
      "embedding: null",
      "concepts: []",
      "confidence: 1",
      "alternatives: []",
      "source_count: 1",
      "reasoning_notes: null",
      "sentiment: null",
      "importance: null",
    ]) {
      expect(md).toContain(key);
    }
  });
  it("serializes a non-null importance", () => {
    const md = atomToMarkdown(fakeAtom({ agi: { ...defaultAgi(), importance: 0.5 } }));
    expect(md).toContain("importance: 0.5");
  });
});

describe("utcDate", () => {
  it("extracts YYYY-MM-DD prefix", () => {
    expect(utcDate("2026-04-15T14:00:00.000Z")).toBe("2026-04-15");
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
    c.calendars.push({ id: "ical-x", provider: "ical", url: "https://example/x.ics" });
    await writeConfig(paths, c);
    const read = await readConfig(paths);
    expect(read.calendars).toHaveLength(1);
    expect(read.calendars[0].url).toBe("https://example/x.ics");
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
    await writeCursors(paths, { "ical-x": "2026-04-15T14:00:00Z" });
    const read = await readCursors(paths);
    expect(read["ical-x"]).toBe("2026-04-15T14:00:00Z");
  });
});

describe("identity IO + learning", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("returns empty map when missing", async () => {
    expect(await readIdentity(makePaths(root))).toEqual({});
  });
  it("self-maps unseen emails", async () => {
    const paths = makePaths(root);
    await writeIdentity(paths, { "eric@acme.test": "eric" });
    const out = await learnIdentities(paths, ["eric@acme.test", "newperson@elsewhere.test"]);
    expect(out["eric@acme.test"]).toBe("eric");
    expect(out["newperson@elsewhere.test"]).toBe("newperson@elsewhere.test");
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
    const t = readFileSync(paths.timeline("2026-04-15"), "utf8");
    expect(t).toContain("calendar_event");
    expect(t).toContain("Postgres migration sync");
  });
  it("is idempotent — second write is a no-op", async () => {
    const paths = makePaths(root);
    await writeAtom(paths, fakeAtom());
    const r2 = await writeAtom(paths, fakeAtom());
    expect(r2.wroteTimeline).toBe(false);
    expect(r2.wroteThreadFiles).toBe(0);
  });
});

describe("writeAtoms batch", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  it("counts written vs skipped (dedup)", async () => {
    const paths = makePaths(root);
    const a1 = fakeAtom();
    const a2 = fakeAtom({ id: "evt-cal-ical-acme-other", ts: "2026-04-16T09:00:00.000Z" });
    const first = await writeAtoms(paths, [a1, a2]);
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);
    const second = await writeAtoms(paths, [a1, a2]);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
