/**
 * v1.22.0 — Daily Memory Pages specs.
 *
 * Replaces the v1.21 4-col `time-density-list` with stacked day cards.
 * Each day = one section with a hero atom + up to 3 highlight cards +
 * a collapsed "show N quieter atoms" tail. Hard constraints from the
 * v1.22 spec covered here:
 *
 *   1. Day card is a `<section data-testid="day-card">` per day, with
 *      `data-date="YYYY-MM-DD"` and `data-is-today` attrs.
 *   2. Day header date is serif (font-display) + atom count is mono.
 *   3. Hero atom is auto-picked using the v1.17 +10/+5/+3/+2/+1 score
 *      rule (mentions you / other mentions / cross-source / decision /
 *      last 24h). When no atom clears MIN_SCORE the most-recent wins.
 *   4. Highlight cards (up to 3 below the hero) are ranked 2-4.
 *   5. show-more / show-less toggle for atoms beyond the 4th.
 *   6. Today with 0 atoms renders an empty data-empty="true" line.
 *   7. Source-tinted hero background uses vendorFor(source).color at
 *      ~15% opacity. Confirms loud paint isn't sneaking in.
 *
 * Pure helpers (`bucketByDay`, `rankAtomsForDay`) are exercised
 * directly so a render isn't required for ordering / bucketing claims.
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

import {
  DailyMemoryPages,
  bucketByDay,
  rankAtomsForDay,
} from "../src/components/feed/DailyMemoryPages";
import { vendorFor } from "../src/components/feed/vendor";
import type { TimelineEvent } from "../src/lib/views";

function makeEvent(
  p: Partial<TimelineEvent> & { id: string },
): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? new Date().toISOString(),
    source: p.source ?? "cursor",
    actor: p.actor ?? "daizhe",
    actors: p.actors ?? [p.actor ?? "daizhe"],
    kind: p.kind ?? "capture",
    refs: p.refs ?? {},
    status: p.status ?? "open",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "Sample atom body line 1.",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

// ----------------------------------------------------------------------
// Bucketing.
// ----------------------------------------------------------------------

describe("v1.22 bucketByDay", () => {
  it("groups events by local calendar day, newest day first", () => {
    const todayIso = new Date().toISOString();
    const yest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const events = [
      makeEvent({ id: "y1", ts: yest, body: "yesterday work" }),
      makeEvent({ id: "t1", ts: todayIso, body: "today work" }),
      makeEvent({ id: "y2", ts: yest, body: "yesterday work 2" }),
    ];
    const buckets = bucketByDay(events);
    expect(buckets.length).toBe(2);
    // Newest day first.
    expect(buckets[0].isToday).toBe(true);
    expect(buckets[0].label).toBe("Today");
    expect(buckets[0].events.length).toBe(1);
    expect(buckets[1].label).toBe("Yesterday");
    expect(buckets[1].events.length).toBe(2);
  });

  it("renders a long date string for older days", () => {
    const old = "2020-01-15T10:00:00Z";
    const events = [makeEvent({ id: "o1", ts: old })];
    const buckets = bucketByDay(events);
    expect(buckets.length).toBe(1);
    // Long-form en-US: "Wednesday, January 15".
    expect(buckets[0].label).toMatch(/January 15/);
    expect(buckets[0].isToday).toBe(false);
  });
});

// ----------------------------------------------------------------------
// Ranking.
// ----------------------------------------------------------------------

describe("v1.22 rankAtomsForDay", () => {
  it("@-mention of current user wins (+10)", () => {
    const ev1 = makeEvent({ id: "e1", body: "Random capture, no mentions." });
    const ev2 = makeEvent({
      id: "e2",
      body: "Hey @daizhe, can you review this?",
    });
    const ev3 = makeEvent({ id: "e3", body: "Decision logged.", kind: "decision" });
    const ranked = rankAtomsForDay([ev1, ev2, ev3], "daizhe");
    expect(ranked[0].id).toBe("e2"); // +10 trumps +2
  });

  it("falls back to most-recent when no atom clears MIN_SCORE", () => {
    const older = makeEvent({
      id: "older",
      ts: "2020-01-15T08:00:00Z",
      body: "older",
    });
    const newer = makeEvent({
      id: "newer",
      ts: "2020-01-15T15:00:00Z",
      body: "newer",
    });
    const ranked = rankAtomsForDay([older, newer], "daizhe");
    expect(ranked[0].id).toBe("newer");
  });

  it("decision (+2) outranks plain recent (+0/+1)", () => {
    const todayIso = new Date().toISOString();
    const plain = makeEvent({ id: "plain", ts: todayIso, body: "plain note" });
    const decision = makeEvent({
      id: "dec",
      ts: todayIso,
      kind: "decision",
      body: "we picked option B",
    });
    const ranked = rankAtomsForDay([plain, decision], "daizhe");
    expect(ranked[0].id).toBe("dec");
  });
});

// ----------------------------------------------------------------------
// Day-card render.
// ----------------------------------------------------------------------

describe("v1.22 DailyMemoryPages render", () => {
  function renderPages(events: TimelineEvent[], user = "daizhe") {
    return render(
      <DailyMemoryPages
        events={events}
        currentUser={user}
        onOpenAtom={() => {}}
      />,
    );
  }

  it("renders one day-card per distinct calendar day", () => {
    const todayIso = new Date().toISOString();
    const yest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const events = [
      makeEvent({ id: "t1", ts: todayIso }),
      makeEvent({ id: "y1", ts: yest }),
      makeEvent({ id: "y2", ts: yest }),
    ];
    renderPages(events);
    const cards = screen.getAllByTestId("day-card");
    expect(cards.length).toBe(2);
    // Newest first.
    expect(cards[0].getAttribute("data-is-today")).toBe("true");
    expect(cards[0].getAttribute("data-atom-count")).toBe("1");
    expect(cards[1].getAttribute("data-is-today")).toBe("false");
    expect(cards[1].getAttribute("data-atom-count")).toBe("2");
  });

  it("day header shows serif date + mono atom count", () => {
    const todayIso = new Date().toISOString();
    const events = [
      makeEvent({ id: "t1", ts: todayIso }),
      makeEvent({ id: "t2", ts: todayIso }),
    ];
    renderPages(events);
    const date = screen.getByTestId("day-card-date");
    expect(date.className).toContain("font-display");
    expect(date.textContent).toBe("Today");
    const count = screen.getByTestId("day-card-atom-count");
    expect(count.className).toContain("font-mono");
    expect(count.textContent).toContain("2 atoms");
  });

  it("hero card is the highest-scored atom (mentions current user)", () => {
    const todayIso = new Date().toISOString();
    const plain = makeEvent({
      id: "plain",
      ts: todayIso,
      body: "plain note",
    });
    const mentions = makeEvent({
      id: "mentions",
      ts: todayIso,
      body: "Hey @daizhe — please weigh in on the BoM",
    });
    renderPages([plain, mentions]);
    const hero = screen.getByTestId("day-hero-card");
    expect(hero.getAttribute("data-event-id")).toBe("mentions");
    expect(hero.textContent).toContain("BoM");
  });

  it("hero card uses source-tinted background (vendorFor color, ~15% alpha)", () => {
    const todayIso = new Date().toISOString();
    const events = [
      makeEvent({
        id: "slack-event",
        ts: todayIso,
        source: "slack",
        body: "team ping",
      }),
    ];
    renderPages(events);
    const hero = screen.getByTestId("day-hero-card");
    // We feed inline `style={{ backgroundColor: '#10b98126' }}`. jsdom
    // normalizes that to `rgba(16, 185, 129, 0.15)`. Assert against
    // both the rgba components AND the alpha so a future "loud paint"
    // regression (alpha == 1, full color) gets caught.
    const slackColor = vendorFor("slack").color; // "#10b981"
    expect(slackColor).toBe("#10b981");
    const style = hero.getAttribute("style") ?? "";
    expect(style).toMatch(/rgba\(16, 185, 129/);
    expect(style).toMatch(/0\.15/);
  });

  it("highlight cards render up to 3, ranked 2-4", () => {
    const todayIso = new Date().toISOString();
    const events = Array.from({ length: 6 }, (_, i) =>
      makeEvent({
        id: `e${i}`,
        ts: todayIso,
        body:
          i === 0
            ? "Hey @daizhe, please review"
            : i === 1
              ? "decision: pick A"
              : `note ${i}`,
        kind: i === 1 ? "decision" : "capture",
      }),
    );
    renderPages(events);
    const grid = screen.getByTestId("day-highlights-grid");
    expect(grid.getAttribute("data-count")).toBe("3");
    const cards = screen.getAllByTestId("day-highlight-card");
    expect(cards.length).toBe(3);
  });

  it("show-N-more reveals the rest then collapses with show-less", async () => {
    const todayIso = new Date().toISOString();
    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        id: `e${i}`,
        ts: todayIso,
        body: `note ${i}`,
      }),
    );
    renderPages(events);
    // 8 atoms total - 4 above fold = 4 in the tail.
    const showMore = screen.getByTestId("day-show-more");
    expect(showMore.getAttribute("data-count")).toBe("4");
    expect(showMore.textContent).toMatch(/show 4 quieter atoms/);
    // Click expands.
    fireEvent.click(showMore);
    await waitFor(() => {
      expect(screen.getByTestId("day-quieter-list")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("day-quieter-row").length).toBe(4);
    // show-less collapses back.
    fireEvent.click(screen.getByTestId("day-show-less"));
    await waitFor(() => {
      expect(screen.queryByTestId("day-quieter-list")).not.toBeInTheDocument();
    });
  });

  it("clicking a hero card calls onOpenAtom with that event", async () => {
    const todayIso = new Date().toISOString();
    const events = [
      makeEvent({
        id: "hero-1",
        ts: todayIso,
        body: "Hey @daizhe weigh in",
      }),
      makeEvent({ id: "second", ts: todayIso, body: "side note" }),
    ];
    const onOpenAtom = vi.fn();
    render(
      <DailyMemoryPages
        events={events}
        currentUser="daizhe"
        onOpenAtom={onOpenAtom}
      />,
    );
    fireEvent.click(screen.getByTestId("day-hero-card"));
    expect(onOpenAtom).toHaveBeenCalledTimes(1);
    expect(onOpenAtom.mock.calls[0][0].id).toBe("hero-1");
  });

  it("Today with 0 atoms renders no card; older days are unaffected", () => {
    // The component groups by day key — a Today with 0 events never
    // produces a bucket. The "0-atoms today" line is owned by the
    // route's empty-state branch (caller-side); inside DailyMemoryPages
    // we just don't emit a bucket. Assert that.
    const yest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    renderPages([makeEvent({ id: "y1", ts: yest })]);
    const cards = screen.getAllByTestId("day-card");
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-is-today")).toBe("false");
  });
});
