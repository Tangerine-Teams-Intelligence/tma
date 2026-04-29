/**
 * v1.17 — HighlightsRow score algorithm tests.
 *
 * The Apple-Photos-Memories paradigm depends on a pure heuristic ranker
 * (no LLM). This file pins the score weights so a future "tune the
 * heuristic" change can't silently shift surfacing without flipping
 * tests. Score components:
 *
 *   +10 atom @-mentions the current user
 *   +5  per other-actor @-mention (capped at 3 mentions = +15)
 *   +3  per concept tag overlap with another atom from a different source
 *   +2  if kind === "decision"
 *   +1  if last-24h
 *
 * Top 5 by score (score >= 1) render as compact cards. Hidden when 0
 * atoms qualify.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { HighlightsRow } from "../src/components/feed/HighlightsRow";
import type { TimelineEvent } from "../src/lib/views";

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? new Date().toISOString(),
    source: p.source ?? "cursor",
    actor: p.actor ?? "alex",
    actors: p.actors ?? [p.actor ?? "alex"],
    kind: p.kind ?? "capture",
    refs: p.refs ?? {},
    status: p.status ?? "open",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "Sample body.",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
});

describe("v1.17 HighlightsRow — auto-surface scoring", () => {
  it("renders nothing when no atom clears the score threshold", () => {
    // All atoms are stale (>24h), no mentions, no concepts, kind=capture.
    // None should clear the +1 threshold.
    const events = [
      makeEvent({
        id: "a",
        ts: "2026-04-26T10:00:00.000Z",
        body: "boring capture, no mention, no tag",
      }),
      makeEvent({
        id: "b",
        ts: "2026-04-26T11:00:00.000Z",
        body: "another stale capture",
      }),
    ];
    const { container } = render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("feed-highlights")).toBeNull();
  });

  it("@me mention scores +10 and surfaces at the top", () => {
    const events = [
      makeEvent({
        id: "low",
        ts: new Date().toISOString(),
        body: "stale capture, no mention",
      }),
      makeEvent({
        id: "hit",
        ts: new Date().toISOString(),
        body: "Hey @daizhe, can you take a look at this?",
      }),
    ];
    render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("highlight-card-hit");
    // +10 (mentions you) + +1 (last 24h) = 11
    expect(card.getAttribute("data-score")).toBe("11");
    expect(card.getAttribute("data-reason")).toBe("mentions you");
  });

  it("decision kind scores +2 over a plain capture", () => {
    const events = [
      makeEvent({
        id: "decision",
        ts: new Date().toISOString(),
        kind: "decision",
        body: "Ratified: ship v1.17 today.",
      }),
    ];
    render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("highlight-card-decision");
    // +2 (decision) + +1 (last 24h) = 3
    expect(card.getAttribute("data-score")).toBe("3");
    expect(card.getAttribute("data-reason")).toBe("decision");
  });

  it("cross-source concept tag scores +3", () => {
    // Same concept "pcb" appears in cursor and slack atoms — should trigger
    // the cross-source bonus on both. Plus +1 each for last-24h.
    const events = [
      makeEvent({
        id: "cc",
        ts: new Date().toISOString(),
        source: "cursor",
        concepts: ["pcb"],
        body: "PCB fab quote came back",
      }),
      makeEvent({
        id: "sl",
        ts: new Date().toISOString(),
        source: "slack",
        concepts: ["pcb"],
        body: "Discussing pcb pricing",
      }),
    ];
    render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("highlight-card-cc").getAttribute("data-score")).toBe(
      "4",
    );
    expect(screen.getByTestId("highlight-card-sl").getAttribute("data-score")).toBe(
      "4",
    );
  });

  it("caps at 5 surfaced atoms even when more qualify", () => {
    // 7 atoms all @-mentioning daizhe — only top 5 should render.
    const events = Array.from({ length: 7 }, (_, i) =>
      makeEvent({
        id: `m${i}`,
        ts: new Date(Date.now() - i * 1000).toISOString(),
        body: `@daizhe item ${i}`,
      }),
    );
    render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    const row = screen.getByTestId("feed-highlights-row");
    expect(row.children.length).toBe(5);
  });

  it("orders by score desc, ts desc as tiebreak", () => {
    const events = [
      // newest @me — should be first (score 11)
      makeEvent({
        id: "newer-me",
        ts: "2026-04-29T11:30:00.000Z",
        body: "@daizhe newest",
      }),
      // older @me — should be second (score 11, but older ts)
      makeEvent({
        id: "older-me",
        ts: "2026-04-29T10:00:00.000Z",
        body: "@daizhe older",
      }),
      // decision (score 3) — should be third
      makeEvent({
        id: "decision",
        ts: "2026-04-29T11:45:00.000Z",
        kind: "decision",
        body: "Decision body",
      }),
    ];
    render(
      <MemoryRouter>
        <HighlightsRow events={events} currentUser="daizhe" />
      </MemoryRouter>,
    );
    const row = screen.getByTestId("feed-highlights-row");
    const ids = [...row.children].map((li) =>
      li.querySelector("button")?.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "highlight-card-newer-me",
      "highlight-card-older-me",
      "highlight-card-decision",
    ]);
  });

  it("invokes onPick when a card is clicked", async () => {
    const onPick = vi.fn();
    const ev = makeEvent({
      id: "click-me",
      ts: new Date().toISOString(),
      body: "@daizhe click target",
    });
    render(
      <MemoryRouter>
        <HighlightsRow events={[ev]} currentUser="daizhe" onPick={onPick} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("highlight-card-click-me");
    card.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(ev);
  });
});
