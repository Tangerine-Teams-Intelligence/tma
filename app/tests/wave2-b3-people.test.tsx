/**
 * v1.16 Wave 2 Agent B3 — /people People grid tests.
 *
 * Spec coverage:
 *   1. Loading state on first paint.
 *   2. Error state when readTimelineRecent throws.
 *   3. Empty state (solo user) renders the Invite CTA.
 *   4. Renders 1 card per unique actor.
 *   5. Activity count (last 24h) per card.
 *   6. Top hashtags extracted from concepts + body `#tag` regex.
 *   7. Default selection = currentUser (highlighted).
 *   8. Click person → filtered AtomCard list updates.
 *   9. Atom list shows only that person's atoms (2 actors mocked).
 *  10. ViewTabs underline /people active.
 *  11. buildPeopleStats sorts by countToday desc.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import PeopleListRoute from "../src/routes/people/index";
import { buildPeopleStats } from "../src/routes/people/index";
import { useStore } from "../src/lib/store";
import * as views from "../src/lib/views";
import type { TimelineEvent } from "../src/lib/views";

function makeEvent(p: Partial<TimelineEvent> & { id: string }): TimelineEvent {
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
    body: p.body ?? "Sample body.",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

const NOW = Date.now();
const HOUR = 3_600_000;

const SAMPLE_EVENTS: TimelineEvent[] = [
  // daizhe — 3 atoms today, 1 yesterday → 3 today
  makeEvent({
    id: "d1",
    ts: new Date(NOW - 1 * HOUR).toISOString(),
    source: "cursor",
    actor: "daizhe",
    body: "Working on #pcb-tier2 pricing tonight",
    concepts: ["pcb", "pricing"],
  }),
  makeEvent({
    id: "d2",
    ts: new Date(NOW - 2 * HOUR).toISOString(),
    source: "claude-code",
    actor: "daizhe",
    body: "Pulled #pcb data from MES",
    concepts: ["pcb"],
  }),
  makeEvent({
    id: "d3",
    ts: new Date(NOW - 5 * HOUR).toISOString(),
    source: "slack",
    actor: "daizhe",
    body: "Sync with hongyu about #patents",
    concepts: ["patents"],
  }),
  makeEvent({
    id: "d4",
    ts: new Date(NOW - 30 * HOUR).toISOString(),
    source: "cursor",
    actor: "daizhe",
    body: "Yesterday entry, NOT today",
    concepts: ["misc"],
  }),
  // hongyu — 1 atom today
  makeEvent({
    id: "h1",
    ts: new Date(NOW - 3 * HOUR).toISOString(),
    source: "slack",
    actor: "hongyu",
    body: "Reviewing #firmware spec",
    concepts: ["firmware"],
  }),
];

beforeEach(() => {
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      currentUser: "daizhe",
    },
  }));
  vi.restoreAllMocks();
});

function renderPeople() {
  return render(
    <MemoryRouter initialEntries={["/people"]}>
      <PeopleListRoute />
    </MemoryRouter>,
  );
}

describe("Wave 2 B3 — /people People grid", () => {
  it("shows the loading state on first paint", () => {
    vi.spyOn(views, "readTimelineRecent").mockImplementation(
      () => new Promise(() => {}),
    );
    renderPeople();
    expect(screen.getByTestId("people-loading")).toBeInTheDocument();
  });

  it("renders an error banner when readTimelineRecent throws", async () => {
    vi.spyOn(views, "readTimelineRecent").mockRejectedValue(new Error("boom"));
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("people-error").textContent).toContain("boom");
  });

  it("renders the empty solo CTA when only the current user has atoms", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [SAMPLE_EVENTS[0]], // only daizhe
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-empty-solo")).toBeInTheDocument();
    });
    expect(screen.getByTestId("people-empty-cta")).toBeInTheDocument();
  });

  it("renders 1 card per unique actor", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-grid")).toBeInTheDocument();
    });
    expect(screen.getByTestId("people-grid").getAttribute("data-count")).toBe("2");
    expect(screen.getByTestId("person-card-daizhe")).toBeInTheDocument();
    expect(screen.getByTestId("person-card-hongyu")).toBeInTheDocument();
  });

  it("renders the last-24h activity count per card", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("person-card-daizhe")).toBeInTheDocument();
    });
    // daizhe: d1, d2, d3 within 24h; d4 is 30h old → "3 today"
    expect(
      screen.getByTestId("person-card-count-daizhe").textContent,
    ).toContain("3 today");
    // hongyu: h1 only → "1 today"
    expect(
      screen.getByTestId("person-card-count-hongyu").textContent,
    ).toContain("1 today");
  });

  it("extracts top hashtags from concepts + body #tag regex", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("person-card-tags-daizhe")).toBeInTheDocument();
    });
    const tags = screen.getByTestId("person-card-tags-daizhe").textContent ?? "";
    // pcb appears in 2 concepts + 1 body match → top
    expect(tags).toContain("#pcb");
  });

  it("highlights currentUser by default", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("person-card-daizhe")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("person-card-daizhe").getAttribute("data-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("person-card-hongyu").getAttribute("data-selected"),
    ).toBe("false");
  });

  it("click person → filtered AtomCard list updates to that actor", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-filtered-list")).toBeInTheDocument();
    });
    // Default = daizhe → list should reflect daizhe
    expect(
      screen.getByTestId("people-filtered-list").getAttribute("data-actor"),
    ).toBe("daizhe");

    fireEvent.click(screen.getByTestId("person-card-hongyu"));

    await waitFor(() => {
      expect(
        screen.getByTestId("people-filtered-list").getAttribute("data-actor"),
      ).toBe("hongyu");
    });
  });

  it("filtered atom list shows only the selected person's atoms", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-filtered-list")).toBeInTheDocument();
    });
    // Default daizhe → 4 atoms
    expect(
      screen.getByTestId("people-filtered-list").getAttribute("data-count"),
    ).toBe("4");
    // Click hongyu → 1 atom
    fireEvent.click(screen.getByTestId("person-card-hongyu"));
    await waitFor(() => {
      expect(
        screen.getByTestId("people-filtered-list").getAttribute("data-count"),
      ).toBe("1");
    });
    // The single hongyu atom card is rendered
    expect(screen.getByTestId("atom-card-h1")).toBeInTheDocument();
  });

  it("ViewTabs renders /people active underline", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("view-tabs")).toBeInTheDocument();
    });
    expect(screen.getByTestId("view-tabs-people-underline")).toBeInTheDocument();
  });

  it("active count header reports # active in last 24h", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderPeople();
    await waitFor(() => {
      expect(screen.getByTestId("people-active-count")).toBeInTheDocument();
    });
    // daizhe + hongyu both have last-24h atoms → 2 active
    expect(screen.getByTestId("people-active-count").textContent).toContain("2");
  });

  it("buildPeopleStats sorts by countToday desc", () => {
    const rows = buildPeopleStats(SAMPLE_EVENTS);
    expect(rows.map((r) => r.alias)).toEqual(["daizhe", "hongyu"]);
    expect(rows[0].countToday).toBe(3);
    expect(rows[1].countToday).toBe(1);
  });
});
