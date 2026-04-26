// Parser tests — feeds real iCal text from fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIcal, pastEvents, upcomingEvents } from "../src/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");

describe("parseIcal", () => {
  it("parses two events from sample.ics", () => {
    const events = parseIcal(fix("sample.ics"), {
      windowStart: new Date("2025-01-01T00:00:00Z"),
      windowEnd: new Date("2032-01-01T00:00:00Z"),
    });
    expect(events).toHaveLength(2);
  });

  it("extracts uid + summary + start", () => {
    const events = parseIcal(fix("sample.ics"));
    const past = events.find((e) => e.uid === "past-event-001@tangerine.test");
    expect(past).toBeDefined();
    expect(past!.summary).toContain("Postgres migration");
    expect(past!.start.toISOString()).toBe("2026-04-15T14:00:00.000Z");
  });

  it("extracts organizer + attendees as emails", () => {
    const events = parseIcal(fix("sample.ics"));
    const past = events.find((e) => e.uid === "past-event-001@tangerine.test");
    expect(past!.organizer).toBe("eric@acme.test");
    expect(past!.attendees).toContain("daizhe@acme.test");
    expect(past!.attendees).toContain("hongyu@acme.test");
  });

  it("extracts location", () => {
    const events = parseIcal(fix("sample.ics"));
    const past = events.find((e) => e.uid === "past-event-001@tangerine.test");
    expect(past!.location).toBe("Zoom");
  });

  it("expands recurrence rules to instances", () => {
    const events = parseIcal(fix("recurring.ics"), {
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2027-01-01T00:00:00Z"),
    });
    // RRULE COUNT=8
    expect(events.length).toBe(8);
    expect(events.every((e) => e.uid === "weekly-standup-001@tangerine.test")).toBe(true);
    // Each is exactly 7 days apart.
    for (let i = 1; i < events.length; i++) {
      const delta = events[i].start.getTime() - events[i - 1].start.getTime();
      expect(delta).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it("respects windowStart for recurrence expansion", () => {
    const events = parseIcal(fix("recurring.ics"), {
      windowStart: new Date("2026-05-15T00:00:00Z"),
      windowEnd: new Date("2027-01-01T00:00:00Z"),
    });
    // First standup is 2026-04-20, eight weekly. windowStart skips first ~3.
    expect(events.length).toBeLessThan(8);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].start >= new Date("2026-05-15")).toBe(true);
  });

  it("throws on malformed input", () => {
    expect(() => parseIcal("not-actually-ical-text")).toThrow();
  });
});

describe("pastEvents / upcomingEvents", () => {
  it("partitions events by `now`", () => {
    const events = parseIcal(fix("sample.ics"), {
      windowStart: new Date("2025-01-01T00:00:00Z"),
      windowEnd: new Date("2032-01-01T00:00:00Z"),
    });
    const now = new Date("2027-01-01T00:00:00Z");
    expect(pastEvents(events, now).length).toBe(1);
    expect(upcomingEvents(events, now).length).toBe(1);
  });
});
