// Integration — runOnce against a fake fetch, asserting full pipeline
// (download → parse → normalize → write → cursor advance) works end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce } from "../src/poll.js";
import { makePaths, writeConfig, readCursors } from "../src/memory.js";
import { defaultConfig } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-cal-int-"));
}

function fakeFetch(text: string): typeof fetch {
  return (async (_url: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    async text() { return text; },
  })) as unknown as typeof fetch;
}

describe("runOnce — full pipeline", () => {
  let root: string;
  beforeEach(async () => {
    root = tmpRoot();
    const cfg = defaultConfig();
    cfg.calendars.push({
      id: "ical-acme",
      provider: "ical",
      name: "Acme Eng",
      url: "https://calendar/x.ics",
    });
    await writeConfig(makePaths(root), cfg);
  });

  it("polls one calendar, writes timeline + thread, advances cursor", async () => {
    const r = await runOnce({
      memoryRoot: root,
      fetch: fakeFetch(fix("sample.ics")),
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(r.calendars.length).toBe(1);
    expect(r.totalAtoms).toBe(2);
    expect(r.totalWritten).toBe(2);

    const paths = makePaths(root);
    const cursors = await readCursors(paths);
    expect(cursors["ical-acme"]).toBe("2027-01-01T00:00:00.000Z");

    expect(existsSync(paths.timeline("2026-04-15"))).toBe(true);
    expect(existsSync(paths.timeline("2030-06-01"))).toBe(true);

    const past = readFileSync(paths.timeline("2026-04-15"), "utf8");
    expect(past).toContain("Postgres migration sync");
    expect(past).toContain("source: calendar");
    expect(past).toContain("kind: calendar_event");
  });

  it("dry-run writes nothing", async () => {
    const r = await runOnce({
      memoryRoot: root,
      fetch: fakeFetch(fix("sample.ics")),
      dryRun: true,
    });
    expect(r.totalAtoms).toBe(2);
    expect(r.totalWritten).toBe(0);
    const paths = makePaths(root);
    expect(existsSync(paths.timeline("2026-04-15"))).toBe(false);
  });

  it("second poll dedups already-seen atoms", async () => {
    await runOnce({ memoryRoot: root, fetch: fakeFetch(fix("sample.ics")) });
    const second = await runOnce({ memoryRoot: root, fetch: fakeFetch(fix("sample.ics")) });
    expect(second.calendars[0].written).toBe(0);
    expect(second.calendars[0].skipped).toBe(2);
  });

  it("written atom on disk has all 8 AGI hook fields", async () => {
    await runOnce({ memoryRoot: root, fetch: fakeFetch(fix("sample.ics")) });
    const paths = makePaths(root);
    const t = readFileSync(paths.timeline("2026-04-15"), "utf8");
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

  it("thread file is created per event", async () => {
    await runOnce({ memoryRoot: root, fetch: fakeFetch(fix("sample.ics")) });
    const paths = makePaths(root);
    const threadDir = join(root, "threads");
    expect(existsSync(threadDir)).toBe(true);
    const files = readdirSync(threadDir);
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f).toMatch(/^cal-ical-acme-/);
    }
  });

  it("recurring events emit one atom per occurrence", async () => {
    const cfg = defaultConfig();
    cfg.calendars.push({
      id: "ical-rec",
      provider: "ical",
      url: "https://calendar/rec.ics",
    });
    const root2 = tmpRoot();
    await writeConfig(makePaths(root2), cfg);
    const r = await runOnce({
      memoryRoot: root2,
      fetch: fakeFetch(fix("recurring.ics")),
    });
    expect(r.calendars[0].atomCount).toBe(8); // RRULE COUNT=8
  });

  it("fetch failure surfaces as channel error", async () => {
    const failingFetch = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      async text() { return ""; },
    })) as unknown as typeof fetch;
    const r = await runOnce({ memoryRoot: root, fetch: failingFetch });
    expect(r.calendars[0].error).toContain("404");
    expect(r.totalWritten).toBe(0);
  });
});
