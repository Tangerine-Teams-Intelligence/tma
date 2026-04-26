// Normalize: parsed events → atoms.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIcal } from "../src/parser.js";
import {
  normalizeEvent,
  makeCtx,
  aliasFor,
  eventSlug,
  slugify,
} from "../src/normalize.js";
import { defaultConfig, type IdentityMap } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");

const identity: IdentityMap = {
  "eric@acme.test": "eric",
  "daizhe@acme.test": "daizhe",
  "hongyu@acme.test": "hongyu",
};
const cfg = defaultConfig();
const ctx = makeCtx(
  { id: "ical-acme", name: "Acme Eng", provider: "ical" },
  identity,
  cfg,
);

describe("aliasFor", () => {
  it("maps known emails to aliases", () => {
    expect(aliasFor("eric@acme.test", identity)).toBe("eric");
  });
  it("returns the raw email if unknown", () => {
    expect(aliasFor("stranger@elsewhere.test", identity)).toBe("stranger@elsewhere.test");
  });
  it("returns 'unknown' for empty/null", () => {
    expect(aliasFor(null, identity)).toBe("unknown");
    expect(aliasFor("", identity)).toBe("unknown");
  });
});

describe("slugify + eventSlug", () => {
  it("slugifies a string lowercase + dash-only", () => {
    expect(slugify("[v1] Postgres MIGRATION sync!")).toBe("v1-postgres-migration-sync");
  });
  it("eventSlug includes date + summary slug", () => {
    expect(eventSlug("past-event-001@tangerine.test", "2026-04-15T14:00:00Z", "Migration sync"))
      .toContain("2026-04-15");
    expect(eventSlug("past-event-001@tangerine.test", "2026-04-15T14:00:00Z", "Migration sync"))
      .toContain("migration-sync");
  });
});

describe("normalizeEvent", () => {
  const events = parseIcal(fix("sample.ics"), {
    windowStart: new Date("2025-01-01"),
    windowEnd: new Date("2032-01-01"),
  });
  const past = events.find((e) => e.uid === "past-event-001@tangerine.test")!;
  const upcoming = events.find((e) => e.uid === "upcoming-event-001@tangerine.test")!;

  it("kind = calendar_event", () => {
    expect(normalizeEvent(past, ctx).kind).toBe("calendar_event");
  });
  it("source = calendar", () => {
    expect(normalizeEvent(past, ctx).source).toBe("calendar");
  });
  it("ts is the event start in RFC 3339", () => {
    expect(normalizeEvent(past, ctx).ts).toBe("2026-04-15T14:00:00.000Z");
  });
  it("actor resolves to organizer alias", () => {
    expect(normalizeEvent(past, ctx).actor).toBe("eric");
  });
  it("actors include all attendees + organizer (resolved)", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.actors).toContain("eric");
    expect(a.actors).toContain("daizhe");
    expect(a.actors).toContain("hongyu");
  });
  it("attaches calendar refs", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.refs.calendar?.provider).toBe("ical");
    expect(a.refs.calendar?.calendar).toBe("ical-acme");
    expect(a.refs.calendar?.uid).toBe("past-event-001@tangerine.test");
    expect(a.refs.calendar?.title).toContain("Postgres migration");
    expect(a.refs.calendar?.location).toBe("Zoom");
  });
  it("derives project from [bracket] prefix", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.refs.projects).toEqual(["v1-launch"]);
  });
  it("creates the per-event thread", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.refs.threads.length).toBe(1);
    expect(a.refs.threads[0]).toMatch(/^cal-ical-acme-2026-04-15-/);
  });
  it("seeds refs.meetings with the event slug for daemon matching", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.refs.meetings).toBeDefined();
    expect(a.refs.meetings!.length).toBe(1);
    expect(a.refs.meetings![0]).toMatch(/^2026-04-15-/);
  });
  it("body opens with title + time range", () => {
    const a = normalizeEvent(past, ctx);
    expect(a.body).toContain("[v1-launch] Postgres migration sync");
    expect(a.body).toContain("UTC");
    expect(a.body).toContain("Location: Zoom");
    expect(a.body).toContain("Attendees:");
  });
  it("upcoming event still produces an atom", () => {
    const a = normalizeEvent(upcoming, ctx);
    expect(a.kind).toBe("calendar_event");
    expect(a.actor).toBe("daizhe");
  });
  it("emits all 8 AGI hook fields with defaults", () => {
    const a = normalizeEvent(past, ctx);
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
