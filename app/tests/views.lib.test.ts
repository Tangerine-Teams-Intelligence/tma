import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  formatClock,
  bucketByDate,
  computeWeekStats,
  type TimelineEvent,
} from "../src/lib/views";

function ev(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: overrides.id ?? "evt-2026-04-25-aaaaaaaaaa",
    ts: overrides.ts ?? "2026-04-25T10:00:00Z",
    source: overrides.source ?? "discord",
    actor: overrides.actor ?? "daizhe",
    actors: overrides.actors ?? [],
    kind: overrides.kind ?? "meeting_chunk",
    refs: overrides.refs ?? {},
    status: overrides.status ?? "active",
    file: overrides.file ?? null,
    line: overrides.line ?? null,
    body: overrides.body ?? "",
    lifecycle: overrides.lifecycle ?? null,
    sample: overrides.sample ?? false,
    confidence: overrides.confidence ?? 1,
    concepts: overrides.concepts ?? [],
    alternatives: overrides.alternatives ?? [],
    source_count: overrides.source_count ?? 1,
  };
}

describe("formatRelativeTime", () => {
  it("returns em dash on null/undefined", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
  });
  it("returns recently on garbage", () => {
    expect(formatRelativeTime("not-an-iso")).toBe("recently");
  });
  it("returns just now for fresh", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5_000).toISOString())).toBe("just now");
  });
  it("rounds minutes", () => {
    expect(formatRelativeTime(new Date(Date.now() - 4 * 60_000).toISOString())).toBe("4 min ago");
  });
  it("rounds hours", () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 60 * 60_000).toISOString())).toBe("3 hr ago");
  });
  it("rounds days", () => {
    expect(formatRelativeTime(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString())).toBe("2 d ago");
  });
});

describe("formatClock", () => {
  it("returns ??:?? for null", () => {
    expect(formatClock(null)).toBe("??:??");
    expect(formatClock(undefined)).toBe("??:??");
  });
  it("extracts HH:MM from rfc3339", () => {
    expect(formatClock("2026-04-25T14:32:11Z")).toBe("14:32");
  });
  it("falls back to date parse if no T-pattern", () => {
    // Date.parse with timezone — assert format only.
    const out = formatClock("2026-04-25 14:00:00");
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
  it("returns ??:?? on garbage", () => {
    expect(formatClock("not-a-date")).toBe("??:??");
  });
});

describe("bucketByDate", () => {
  it("returns empty for empty input", () => {
    expect(bucketByDate([])).toEqual([]);
  });
  it("buckets by YYYY-MM-DD prefix", () => {
    const a = ev({ id: "evt-2026-04-25-1111111111", ts: "2026-04-25T10:00:00Z" });
    const b = ev({ id: "evt-2026-04-25-2222222222", ts: "2026-04-25T11:00:00Z" });
    const c = ev({ id: "evt-2026-04-24-3333333333", ts: "2026-04-24T17:00:00Z" });
    const out = bucketByDate([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0].date).toBe("2026-04-25");
    expect(out[0].events).toHaveLength(2);
    expect(out[1].date).toBe("2026-04-24");
  });
  it("sorts dates descending", () => {
    const a = ev({ id: "evt-2026-04-22-aaaaaaaaaa", ts: "2026-04-22T10:00:00Z" });
    const b = ev({ id: "evt-2026-04-25-bbbbbbbbbb", ts: "2026-04-25T10:00:00Z" });
    const c = ev({ id: "evt-2026-04-23-cccccccccc", ts: "2026-04-23T10:00:00Z" });
    const out = bucketByDate([a, b, c]);
    expect(out.map((b) => b.date)).toEqual(["2026-04-25", "2026-04-23", "2026-04-22"]);
  });
});

describe("computeWeekStats", () => {
  it("returns zeros on empty", () => {
    const s = computeWeekStats([]);
    expect(s.total).toBe(0);
    expect(s.meetings).toBe(0);
    expect(s.decisions).toBe(0);
    expect(s.prs).toBe(0);
    expect(s.tickets).toBe(0);
    expect(s.by_member).toEqual({});
  });
  it("counts each kind", () => {
    const s = computeWeekStats([
      ev({ id: "1aaaaaaaaaaaa", kind: "meeting_chunk" }),
      ev({ id: "2bbbbbbbbbbbb", kind: "meeting_chunk" }),
      ev({ id: "3ccccccccccc", kind: "decision" }),
      ev({ id: "4ddddddddddd", kind: "pr_event" }),
      ev({ id: "5eeeeeeeeeee", kind: "comment" }),
      ev({ id: "6fffffffffff", kind: "ticket_event" }),
    ]);
    expect(s.total).toBe(6);
    expect(s.meetings).toBe(2);
    expect(s.decisions).toBe(1);
    expect(s.prs).toBe(1);
    expect(s.comments).toBe(1);
    expect(s.tickets).toBe(1);
  });
  it("aggregates by_member from actor + actors", () => {
    const s = computeWeekStats([
      ev({ id: "1aaaaaaaaaaaa", actor: "daizhe", actors: ["eric"] }),
      ev({ id: "2bbbbbbbbbbbb", actor: "daizhe", actors: ["sarah"] }),
    ]);
    expect(s.by_member.daizhe).toBe(2);
    expect(s.by_member.eric).toBe(1);
    expect(s.by_member.sarah).toBe(1);
  });
  it("ignores sample atoms", () => {
    const s = computeWeekStats([
      ev({ id: "1aaaaaaaaaaaa", kind: "meeting_chunk", sample: true }),
      ev({ id: "2bbbbbbbbbbbb", kind: "meeting_chunk", sample: false }),
    ]);
    expect(s.meetings).toBe(1);
    expect(s.total).toBe(1);
  });
});
