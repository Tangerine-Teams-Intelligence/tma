/**
 * v1.16 Wave 3 Agent C2 — animated empty-state component + integration.
 *
 * Spec coverage:
 *   1. Component renders 5 sample atom cards.
 *   2. variant="feed"   → feed-specific headline.
 *   3. variant="threads"→ threads-specific headline.
 *   4. variant="people" → people-specific headline.
 *   5. First sample card carries data-pulse="true".
 *   6. /feed integration: events=[] renders the animation.
 *   7. /threads integration: 0 threads renders the animation.
 *   8. /people integration: solo user (0 active teammates) renders the
 *      animation alongside the legacy invite CTA.
 *   9. CTA copy ("如果 60 秒还没出现 → check Settings") is present.
 *  10. Same 5 sample event ids regardless of variant (stable contract).
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { EmptyStateAnimation } from "../src/components/onboarding/EmptyStateAnimation";
import FeedRoute from "../src/routes/feed";
import ThreadsListRoute from "../src/routes/threads";
import PeopleListRoute from "../src/routes/people";
import { useStore } from "../src/lib/store";
import * as views from "../src/lib/views";

beforeEach(() => {
  // Wave 2 routes drive a few flags off zustand — pin them so each spec
  // starts from the same baseline regardless of execution order.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      currentUser: "daizhe",
    },
  }));
  vi.restoreAllMocks();
});

describe("Wave 3 C2 — EmptyStateAnimation component", () => {
  it("renders 5 sample atom cards", () => {
    render(<EmptyStateAnimation variant="feed" />);
    const list = screen.getByTestId("empty-state-animation-list-feed");
    expect(list.getAttribute("data-count")).toBe("5");
    expect(screen.getByTestId("empty-state-sample-sample-1")).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-sample-sample-2")).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-sample-sample-3")).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-sample-sample-4")).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-sample-sample-5")).toBeInTheDocument();
  });

  it("variant=feed shows feed-specific headline", () => {
    render(<EmptyStateAnimation variant="feed" />);
    expect(
      screen.getByTestId("empty-state-animation-title-feed").textContent,
    ).toContain("captures");
  });

  it("variant=threads shows threads-specific headline", () => {
    render(<EmptyStateAnimation variant="threads" />);
    expect(
      screen.getByTestId("empty-state-animation-title-threads").textContent,
    ).toContain("thread");
  });

  it("variant=people shows people-specific headline", () => {
    render(<EmptyStateAnimation variant="people" />);
    expect(
      screen.getByTestId("empty-state-animation-title-people").textContent,
    ).toContain("队友");
  });

  it("first sample carries the pulse animation marker", () => {
    render(<EmptyStateAnimation variant="feed" />);
    const first = screen.getByTestId("empty-state-sample-sample-1");
    expect(first.getAttribute("data-pulse")).toBe("true");
    expect(first.className).toContain("animate-pulse");
    // Other cards explicitly opt out so the pulse stays subtle.
    expect(
      screen.getByTestId("empty-state-sample-sample-2").getAttribute("data-pulse"),
    ).toBe("false");
  });

  it("renders the 60-second CTA hint", () => {
    render(<EmptyStateAnimation variant="feed" />);
    expect(
      screen.getByTestId("empty-state-animation-cta-feed").textContent,
    ).toContain("Settings");
  });

  it("v1.17 — /feed empty events renders the quiet 'Waiting' state, not the animation", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/feed"]}>
        <FeedRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("feed-empty-no-captures")).toBeInTheDocument();
    });
    // v1.17 retired the synthetic 5-atom preview — must not render.
    expect(screen.queryByTestId("empty-state-animation-feed")).toBeNull();
    expect(screen.queryByTestId("empty-state-animation-list-feed")).toBeNull();
    // The replacement copy is the only signal the feed is alive.
    expect(screen.getByTestId("feed-empty-no-captures").textContent).toContain(
      "Waiting for first capture",
    );
  });

  it("v1.17 — /threads 0 threads renders quiet 'No threads yet' state, not the animation", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/threads"]}>
        <ThreadsListRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("threads-empty-no-captures")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("empty-state-animation-threads")).toBeNull();
    expect(screen.getByTestId("threads-empty-no-captures").textContent).toContain(
      "No threads yet",
    );
  });

  it("v1.17 — /people solo user renders only the legacy invite CTA, no synthetic preview", async () => {
    // Single atom from the current user → people.length === 1 → isSolo.
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [
        {
          id: "p1",
          ts: new Date(Date.now() - 60_000).toISOString(),
          source: "cursor",
          actor: "daizhe",
          actors: ["daizhe"],
          kind: "capture",
          refs: {},
          status: "open",
          file: null,
          line: null,
          body: "Just me, no teammates yet.",
          lifecycle: null,
          sample: false,
          confidence: 1.0,
          concepts: [],
          alternatives: [],
          source_count: 1,
        },
      ],
      notes: [],
    });
    render(
      <MemoryRouter initialEntries={["/people"]}>
        <PeopleListRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("people-empty-solo")).toBeInTheDocument();
    });
    // v1.17 dropped the synthetic 5-teammate preview (R6 honesty —
    // fake names broke trust). Only the real invite CTA remains.
    expect(screen.queryByTestId("empty-state-animation-people")).toBeNull();
    expect(screen.getByTestId("people-empty-cta")).toBeInTheDocument();
  });
});
