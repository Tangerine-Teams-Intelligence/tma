/**
 * v1.16 Wave 2 Agent B1 — /feed Story Feed tests.
 *
 * Spec coverage:
 *   1. Renders the loading state on first paint, then the feed list
 *      after readTimelineRecent resolves.
 *   2. Renders an error banner when readTimelineRecent throws.
 *   3. Renders the no-captures empty state when source returns 0 events.
 *   4. Renders the filtered-out empty state when filter chips strip
 *      every atom.
 *   5. Day separators bucket atoms by date.
 *   6. AtomCard renders vendor color dot + author + relative time.
 *   7. @mention atoms get the orange left-border (data-mention="true").
 *   8. Long bodies (>200 chars) collapse to a "Read full" affordance.
 *   9. FilterChips: @Me, Today, source-vendor toggles all work.
 *  10. Cmd+/ focuses the search input.
 *  11. ViewTabs renders all three view links and highlights /feed.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import FeedRoute from "../src/routes/feed";
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
    body: p.body ?? "Sample atom body line 1.",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

const SAMPLE_EVENTS: TimelineEvent[] = [
  makeEvent({
    id: "e1",
    ts: new Date(Date.now() - 60_000).toISOString(),
    source: "cursor",
    actor: "daizhe",
    body: "PCB Tier-2 痛点 — 兴森 70% gross margin 是不可能的, 实际 18%.",
    concepts: ["pcb", "pricing"],
  }),
  makeEvent({
    id: "e2",
    ts: new Date(Date.now() - 2 * 3600_000).toISOString(),
    source: "slack",
    actor: "hongyu",
    body: "@daizhe 需要确认 BOM 第 3 项数字",
  }),
  makeEvent({
    id: "e3",
    ts: new Date(Date.now() - 26 * 3600_000).toISOString(),
    source: "claude-code",
    actor: "daizhe",
    body:
      "This is a long atom body. ".repeat(20) + "Should trigger Read full.",
  }),
];

beforeEach(() => {
  // Reset known store fields so tests don't see leakage from earlier specs.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      currentUser: "daizhe",
    },
  }));
  vi.restoreAllMocks();
});

function renderFeed() {
  return render(
    <MemoryRouter initialEntries={["/feed"]}>
      <FeedRoute />
    </MemoryRouter>,
  );
}

describe("Wave 2 B1 — /feed Story Feed", () => {
  it("shows the loading state then renders the feed list", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    expect(screen.getByTestId("feed-loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("feed-list")).toBeInTheDocument();
    });
    expect(screen.getByTestId("feed-list").getAttribute("data-count")).toBe("3");
  });

  it("renders an error banner when readTimelineRecent throws", async () => {
    vi.spyOn(views, "readTimelineRecent").mockRejectedValue(new Error("boom"));
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("feed-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("feed-error").textContent).toContain("boom");
  });

  it("renders the no-captures empty state when 0 events", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("feed-empty-no-captures")).toBeInTheDocument();
    });
  });

  it("buckets events by date with sticky day separators", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("feed-list")).toBeInTheDocument();
    });
    // Today (e1, e2) and yesterday (e3) → 2 separators.
    const seps = screen.getAllByText(/Today|Yesterday|^\w{3} \w{3} \d+$/);
    expect(seps.length).toBeGreaterThanOrEqual(2);
  });

  it("renders vendor color dot + author + relative time per AtomCard", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("atom-card-e1")).toBeInTheDocument();
    });
    const card = screen.getByTestId("atom-card-e1");
    expect(card.getAttribute("data-vendor")).toBe("Cursor");
    expect(card.textContent).toContain("daizhe");
    // The dot is rendered with a stable test id keyed off vendor display.
    expect(screen.getAllByTestId(/^vendor-dot-/).length).toBeGreaterThan(0);
  });

  it("flags @mention atoms with the orange left-border (data-mention)", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("atom-card-e2")).toBeInTheDocument();
    });
    expect(screen.getByTestId("atom-card-e2").getAttribute("data-mention")).toBe(
      "true",
    );
    expect(screen.getByTestId("atom-card-e1").getAttribute("data-mention")).toBe(
      "false",
    );
  });

  it("long atoms (>200 chars) get a Read full toggle", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() => {
      expect(screen.getByTestId("atom-card-e3")).toBeInTheDocument();
    });
    expect(screen.getByTestId("atom-card-toggle-e3")).toBeInTheDocument();
  });

  it("@Me filter chip restricts to current-user authored atoms", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("feed-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("feed-filter-me"));
    await waitFor(() =>
      expect(
        screen.getByTestId("feed-list").getAttribute("data-count"),
      ).toBe("2"),
    );
  });

  it("source-vendor chip restricts to that source", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("feed-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("feed-filter-source-slack"));
    await waitFor(() =>
      expect(
        screen.getByTestId("feed-list").getAttribute("data-count"),
      ).toBe("1"),
    );
  });

  it("Today filter strips atoms older than 24h", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("feed-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("feed-filter-today"));
    await waitFor(() =>
      expect(
        screen.getByTestId("feed-list").getAttribute("data-count"),
      ).toBe("2"),
    );
  });

  it("renders filtered-out empty state when chips strip everything", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("feed-list")).toBeInTheDocument(),
    );
    const search = screen.getByTestId("feed-search-input") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "definitely-not-in-any-atom" } });
    await waitFor(() =>
      expect(screen.getByTestId("feed-empty-filtered")).toBeInTheDocument(),
    );
  });

  it("Cmd+/ focuses the search input", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("feed-list")).toBeInTheDocument(),
    );
    const input = screen.getByTestId("feed-search-input");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", metaKey: true }),
      );
    });
    expect(document.activeElement).toBe(input);
  });

  it("ViewTabs renders Feed/Threads/People links", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByTestId("view-tabs")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("view-tabs-feed")).toBeInTheDocument();
    expect(screen.getByTestId("view-tabs-threads")).toBeInTheDocument();
    expect(screen.getByTestId("view-tabs-people")).toBeInTheDocument();
    // Feed is active in MemoryRouter @ /feed.
    expect(screen.getByTestId("view-tabs-feed-underline")).toBeInTheDocument();
  });
});
