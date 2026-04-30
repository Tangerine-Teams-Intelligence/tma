/**
 * v1.18.0 — HeatmapLayer + bucketing pure-function tests.
 *
 * Pins the contract: cells bucket by (day, actor); empty cells render
 * with density band 0; the density ramp is monotonic in count; the
 * 30-day axis renders all calendar slots even when atoms are sparse.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { HeatmapLayer } from "../src/components/canvas/HeatmapLayer";
import {
  bucketHeatmap,
  dayAxis,
  densityBand,
  peopleAxis,
  computeMentionEdges,
  mentionsOf,
} from "../src/components/canvas/bucketing";
import type { TimelineEvent } from "../src/lib/views";

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    id: p.id,
    ts: p.ts ?? "2026-04-29T10:00:00Z",
    source: p.source ?? "cursor",
    actor: p.actor ?? "daizhe",
    actors: p.actors ?? [p.actor ?? "daizhe"],
    kind: p.kind ?? "note",
    refs: p.refs ?? {},
    status: p.status ?? "active",
    file: p.file ?? null,
    line: p.line ?? null,
    body: p.body ?? "",
    sample: p.sample ?? false,
    confidence: p.confidence ?? 1,
    concepts: p.concepts ?? [],
    alternatives: p.alternatives ?? [],
    source_count: p.source_count ?? 1,
  };
}

describe("v1.18.0 — bucketing math", () => {
  it("dayAxis produces N consecutive day strings ending at the anchor", () => {
    const anchor = Date.parse("2026-04-29T12:00:00Z");
    const axis = dayAxis(7, anchor);
    expect(axis).toHaveLength(7);
    expect(axis[axis.length - 1]).toBe("2026-04-29");
    expect(axis[0]).toBe("2026-04-23");
    // Strict ascending order so the heat-map paints oldest-left.
    for (let i = 1; i < axis.length; i += 1) {
      expect(axis[i] > axis[i - 1]).toBe(true);
    }
  });

  it("peopleAxis sorts actors by activity desc, then alphabetically", () => {
    const events = [
      makeEvent({ id: "1", actor: "alice" }),
      makeEvent({ id: "2", actor: "bob" }),
      makeEvent({ id: "3", actor: "bob" }),
      makeEvent({ id: "4", actor: "carol" }),
      makeEvent({ id: "5", actor: "carol" }),
      makeEvent({ id: "6", actor: "carol" }),
    ];
    const axis = peopleAxis(events);
    expect(axis).toEqual(["carol", "bob", "alice"]);
  });

  it("bucketHeatmap counts atoms per (day, actor) and tracks the max", () => {
    const events = [
      makeEvent({ id: "1", ts: "2026-04-28T10:00:00Z", actor: "alice" }),
      makeEvent({ id: "2", ts: "2026-04-28T11:00:00Z", actor: "alice" }),
      makeEvent({ id: "3", ts: "2026-04-28T12:00:00Z", actor: "alice" }),
      makeEvent({ id: "4", ts: "2026-04-29T09:00:00Z", actor: "bob" }),
    ];
    const buckets = bucketHeatmap(events);
    expect(buckets.cells.get("2026-04-28|alice")?.count).toBe(3);
    expect(buckets.cells.get("2026-04-29|bob")?.count).toBe(1);
    expect(buckets.cells.get("2026-04-29|alice")).toBeUndefined();
    expect(buckets.max).toBe(3);
  });

  it("densityBand maps 0 → 0 and saturates at 4 (monotonic)", () => {
    expect(densityBand(0, 10)).toBe(0);
    expect(densityBand(1, 10)).toBe(1);
    expect(densityBand(3, 10)).toBe(2);
    expect(densityBand(6, 10)).toBe(3);
    expect(densityBand(10, 10)).toBe(4);
    // Edge: max=0 (degenerate) collapses to band 0 so we don't divide
    // by zero.
    expect(densityBand(0, 0)).toBe(0);
  });

  it("mentionsOf parses @aliases case-insensitively, dedupes + sorts", () => {
    const m = mentionsOf("hi @Daizhe and @hongyu, also @daizhe again");
    expect(m).toEqual(["daizhe", "hongyu"]);
  });

  it("computeMentionEdges links atoms whose mention sets overlap", () => {
    const events = [
      makeEvent({ id: "ev-a", body: "@daizhe @hongyu spec" }),
      makeEvent({ id: "ev-b", body: "@hongyu ack" }),
      makeEvent({ id: "ev-c", body: "@unrelated" }),
    ];
    const edges = computeMentionEdges(events);
    expect(edges.find((e) => e.from === "ev-a" && e.to === "ev-b")).toBeTruthy();
    expect(
      edges.find(
        (e) =>
          (e.from === "ev-a" && e.to === "ev-c") ||
          (e.from === "ev-c" && e.to === "ev-a"),
      ),
    ).toBeFalsy();
  });
});

describe("v1.18.0 — HeatmapLayer render", () => {
  it("renders one rect per (day × actor) slot in the axis", () => {
    const events = [
      makeEvent({ id: "1", ts: "2026-04-29T09:00:00Z", actor: "alice" }),
      makeEvent({ id: "2", ts: "2026-04-29T11:00:00Z", actor: "bob" }),
    ];
    const anchor = Date.parse("2026-04-29T23:59:59Z");
    const { container } = render(
      <svg>
        <HeatmapLayer events={events} days={3} anchorMs={anchor} />
      </svg>,
    );
    const layer = container.querySelector(
      '[data-testid="heatmap-layer"]',
    );
    expect(layer).toBeTruthy();
    const cells = container.querySelectorAll('[data-testid^="heat-cell-"]');
    // 3 days × 2 actors = 6 cells. Even when only 2 of them have
    // atoms, the empty cells render as transparent slots.
    expect(cells.length).toBe(6);
    expect(layer?.getAttribute("data-max-density")).toBe("1");
  });

  it("encodes the density band on each cell so tests can assert color tier", () => {
    const events = [
      makeEvent({ id: "1", ts: "2026-04-29T09:00:00Z", actor: "alice" }),
      makeEvent({ id: "2", ts: "2026-04-29T11:00:00Z", actor: "alice" }),
    ];
    const anchor = Date.parse("2026-04-29T23:59:59Z");
    const { container } = render(
      <svg>
        <HeatmapLayer events={events} days={1} anchorMs={anchor} />
      </svg>,
    );
    const cell = container.querySelector(
      '[data-testid="heat-cell-2026-04-29-alice"]',
    );
    expect(cell?.getAttribute("data-count")).toBe("2");
    // 2 atoms, max=2 → ratio 1.0 → band 4.
    expect(cell?.getAttribute("data-density")).toBe("4");
  });
});
