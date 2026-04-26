// Pre-meeting brief trigger + composer tests.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIcal } from "../src/parser.js";
import { nextBriefTriggers, briefForEvent, pollBriefTriggers } from "../src/briefs.js";
import { makePaths, writeConfig } from "../src/memory.js";
import { defaultConfig } from "../src/types.js";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tg-cal-brief-"));
}

describe("nextBriefTriggers", () => {
  const events = parseIcal(fix("sample.ics"), {
    windowStart: new Date("2025-01-01"),
    windowEnd: new Date("2032-01-01"),
  });

  it("finds an upcoming event in the [now+0, now+5] window", () => {
    // upcoming-event-001 starts 2030-06-01T16:00:00Z
    const now = new Date("2030-06-01T15:57:00Z"); // 3 min before
    const triggers = nextBriefTriggers(events, { now, leadMinutes: 5, windowMinutes: 10, calendar: "ical-x" });
    expect(triggers.length).toBe(1);
    expect(triggers[0].title).toContain("Investor pitch");
    expect(triggers[0].minutesUntil).toBe(3);
  });

  it("excludes events too far in the future", () => {
    const now = new Date("2030-05-01T16:00:00Z"); // a month ahead
    const triggers = nextBriefTriggers(events, { now, leadMinutes: 5, windowMinutes: 10, calendar: "ical-x" });
    expect(triggers.length).toBe(0);
  });

  it("excludes past events", () => {
    const now = new Date("2030-06-01T20:00:00Z");
    const triggers = nextBriefTriggers(events, { now, leadMinutes: 5, windowMinutes: 10, calendar: "ical-x" });
    expect(triggers.length).toBe(0);
  });

  it("attaches calendar id + attendees", () => {
    const now = new Date("2030-06-01T15:57:00Z");
    const triggers = nextBriefTriggers(events, { now, leadMinutes: 5, windowMinutes: 10, calendar: "my-cal" });
    expect(triggers[0].calendar).toBe("my-cal");
    expect(triggers[0].attendees).toContain("eric@acme.test");
  });

  it("respects custom leadMinutes", () => {
    // 12 min before — outside default 5min lead, inside 15min
    const now = new Date("2030-06-01T15:48:00Z");
    expect(nextBriefTriggers(events, { now, leadMinutes: 5, windowMinutes: 10, calendar: "x" })).toHaveLength(0);
    expect(nextBriefTriggers(events, { now, leadMinutes: 15, windowMinutes: 5, calendar: "x" })).toHaveLength(1);
  });
});

describe("briefForEvent", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it("composes a brief with title + minutes-until", async () => {
    const md = await briefForEvent(root, {
      slug: "test-slug",
      title: "Investor pitch",
      start: "2030-06-01T16:00:00Z",
      minutesUntil: 5,
      calendar: "ical-x",
      attendees: ["eric@acme.test"],
      location: "Zoom",
    });
    expect(md).toContain("Pre-meeting brief — Investor pitch");
    expect(md).toContain("Starts in 5 min");
    expect(md).toContain("Attendees: eric@acme.test");
    expect(md).toContain("Location: Zoom");
  });

  it("scans timeline files for matches", async () => {
    mkdirSync(join(root, "timeline"), { recursive: true });
    writeFileSync(
      join(root, "timeline", "2030-05-30.md"),
      "# yesterday\n- discussed Investor pitch deck\n",
    );
    const md = await briefForEvent(root, {
      slug: "test",
      title: "Investor pitch",
      start: "2030-06-01T16:00:00Z",
      minutesUntil: 5,
      calendar: "ical-x",
      attendees: [],
      location: null,
    });
    expect(md).toContain("Relevant prior context");
    expect(md).toContain("timeline/2030-05-30.md");
  });

  it("falls back to 'no prior threads' when memory empty", async () => {
    const md = await briefForEvent(root, {
      slug: "test",
      title: "Random fresh topic",
      start: "2030-06-01T16:00:00Z",
      minutesUntil: 5,
      calendar: "ical-x",
      attendees: [],
      location: null,
    });
    expect(md).toContain("No prior threads matched");
  });
});

describe("pollBriefTriggers", () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it("returns [] when no calendars configured", async () => {
    const triggers = await pollBriefTriggers({ memoryRoot: root });
    expect(triggers).toEqual([]);
  });

  it("uses fetch override to load iCal text", async () => {
    const paths = makePaths(root);
    const cfg = defaultConfig();
    cfg.calendars.push({ id: "ical-x", provider: "ical", url: "https://example/x.ics" });
    await writeConfig(paths, cfg);

    const fakeFetch = (async (_url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async text() { return fix("sample.ics"); },
    })) as unknown as typeof fetch;

    const triggers = await pollBriefTriggers({
      memoryRoot: root,
      now: new Date("2030-06-01T15:57:00Z"),
      fetch: fakeFetch,
    });
    expect(triggers.length).toBe(1);
    expect(triggers[0].title).toContain("Investor pitch");
  });
});
