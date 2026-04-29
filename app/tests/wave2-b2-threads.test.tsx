/**
 * v1.16 Wave 2 Agent B2 — /threads tests.
 *
 * Spec coverage:
 *   1. Loading state on first paint.
 *   2. Error banner when readTimelineRecent rejects + retry button works.
 *   3. Empty (zero captures) state.
 *   4. Mention-set grouping: 3 atoms across 2 distinct mention sets +
 *      1 unmentioned → 3 threads (2 named + Uncategorized).
 *   5. ThreadCard renders title + atom count + latest preview.
 *   6. Click toggle → expanded state shows AtomCard list.
 *   7. Re-click toggle → collapses back.
 *   8. Multi-mention thread title joins all mentions.
 *   9. v1.17 — ViewTabs killed (Sidebar nav covers Feed/Threads/People).
 *  10. Search filter narrows by mention substring + emits filtered-empty
 *      state when nothing matches.
 *  11. Threads sorted by latest atom ts (most-recent first).
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import ThreadsListRoute from "../src/routes/threads";
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
    body: p.body ?? "Sample body",
    lifecycle: null,
    sample: false,
    confidence: 1.0,
    concepts: p.concepts ?? [],
    alternatives: [],
    source_count: 1,
  };
}

const NOW = Date.now();
const SAMPLE_EVENTS: TimelineEvent[] = [
  // Thread "with @hongyu" — 2 atoms.
  makeEvent({
    id: "e1",
    ts: new Date(NOW - 60_000).toISOString(),
    actor: "daizhe",
    body: "@hongyu BOM 第3项数字需要复核 — 厂里给的是 ¥4.2 但 datasheet 是 ¥3.8.",
  }),
  makeEvent({
    id: "e2",
    ts: new Date(NOW - 5 * 3600_000).toISOString(),
    actor: "daizhe",
    body: "@hongyu watch firmware build green, 等你 sign-off.",
  }),
  // Thread "with @hongyu, @bob" — distinct multi-mention set.
  makeEvent({
    id: "e3",
    ts: new Date(NOW - 2 * 3600_000).toISOString(),
    actor: "daizhe",
    body: "@hongyu @bob review the v0.3 schematic when you have a sec.",
  }),
  // Uncategorized (no mention).
  makeEvent({
    id: "e4",
    ts: new Date(NOW - 30 * 60_000).toISOString(),
    actor: "daizhe",
    body: "Quick note: refactored the alignment loop.",
  }),
];

beforeEach(() => {
  vi.restoreAllMocks();
});

function renderThreads() {
  return render(
    <MemoryRouter initialEntries={["/threads"]}>
      <ThreadsListRoute />
    </MemoryRouter>,
  );
}

describe("Wave 2 B2 — /threads route", () => {
  it("shows the loading state on first paint", () => {
    vi.spyOn(views, "readTimelineRecent").mockImplementation(
      () => new Promise(() => {}),
    );
    renderThreads();
    expect(screen.getByTestId("threads-loading")).toBeInTheDocument();
  });

  it("renders an error banner when readTimelineRecent rejects", async () => {
    vi.spyOn(views, "readTimelineRecent").mockRejectedValue(
      new Error("boom"),
    );
    renderThreads();
    await waitFor(() => {
      expect(screen.getByTestId("threads-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("threads-error").textContent).toContain("boom");
    expect(screen.getByTestId("threads-retry")).toBeInTheDocument();
  });

  it("renders the no-captures empty state when zero atoms", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderThreads();
    await waitFor(() => {
      expect(screen.getByTestId("threads-empty-no-captures")).toBeInTheDocument();
    });
  });

  it("groups atoms by mention set into distinct threads", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() => {
      expect(screen.getByTestId("threads-list")).toBeInTheDocument();
    });
    // Three threads expected: with-hongyu, with-bob+hongyu, uncategorized.
    expect(screen.getByTestId("threads-list").getAttribute("data-count")).toBe("3");
    expect(screen.getByTestId("thread-card-hongyu")).toBeInTheDocument();
    expect(screen.getByTestId("thread-card-bob,hongyu")).toBeInTheDocument();
    expect(screen.getByTestId("thread-card-uncategorized")).toBeInTheDocument();
  });

  it("ThreadCard renders title, atom count, and latest preview", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("thread-card-title-hongyu").textContent).toBe(
      "with @hongyu",
    );
    expect(screen.getByTestId("thread-card-count-hongyu").textContent).toContain(
      "2 atom",
    );
    // Latest atom in @hongyu thread is e1 (most recent ts).
    expect(
      screen.getByTestId("thread-card-preview-hongyu").textContent,
    ).toContain("BOM");
  });

  it("expands inline AtomCard list on toggle click", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("thread-card-toggle-hongyu"));
    await waitFor(() => {
      expect(
        screen.getByTestId("thread-card-expanded-hongyu"),
      ).toBeInTheDocument();
    });
    // Both atoms in the @hongyu thread should be rendered as AtomCards.
    expect(screen.getByTestId("atom-card-e1")).toBeInTheDocument();
    expect(screen.getByTestId("atom-card-e2")).toBeInTheDocument();
  });

  it("collapses when toggle is re-clicked", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    const toggle = screen.getByTestId("thread-card-toggle-hongyu");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("thread-card-expanded-hongyu")).toBeInTheDocument(),
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(
        screen.queryByTestId("thread-card-expanded-hongyu"),
      ).not.toBeInTheDocument();
    });
  });

  it("multi-mention thread title joins all mentions", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("thread-card-title-bob,hongyu").textContent,
    ).toBe("with @bob, @hongyu");
  });

  it("v1.17 — ViewTabs is no longer rendered inside /threads", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-route")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("view-tabs")).toBeNull();
    expect(screen.queryByTestId("view-tabs-threads")).toBeNull();
  });

  it("search filter narrows threads by @mention substring", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    const search = screen.getByTestId(
      "threads-search-input",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "bob" } });
    await waitFor(() =>
      expect(
        screen.getByTestId("threads-list").getAttribute("data-count"),
      ).toBe("1"),
    );
    expect(screen.getByTestId("thread-card-bob,hongyu")).toBeInTheDocument();
  });

  it("renders filtered-empty state when search matches nothing", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    const search = screen.getByTestId(
      "threads-search-input",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzz-no-match-xyz" } });
    await waitFor(() =>
      expect(
        screen.getByTestId("threads-empty-filtered"),
      ).toBeInTheDocument(),
    );
  });

  it("threads sorted newest-first by latest atom ts", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    const list = screen.getByTestId("threads-list");
    // Outer <article> cards expose data-thread-key — inner toggles don't.
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>("article[data-thread-key]"),
    );
    // Most-recent first: e1 (60s ago, hongyu) → uncategorized (30m ago, e4)
    // → bob,hongyu (2h ago, e3). hongyu's latest is e1 = NOW-60s, beats
    // uncategorized e4 = NOW-30m.
    expect(cards[0].getAttribute("data-testid")).toBe("thread-card-hongyu");
    expect(cards[1].getAttribute("data-testid")).toBe(
      "thread-card-uncategorized",
    );
    expect(cards[2].getAttribute("data-testid")).toBe("thread-card-bob,hongyu");
  });

  it("retry button re-invokes readTimelineRecent after error", async () => {
    const spy = vi
      .spyOn(views, "readTimelineRecent")
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ events: SAMPLE_EVENTS, notes: [] });
    renderThreads();
    await waitFor(() =>
      expect(screen.getByTestId("threads-error")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("threads-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("threads-list")).toBeInTheDocument(),
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
