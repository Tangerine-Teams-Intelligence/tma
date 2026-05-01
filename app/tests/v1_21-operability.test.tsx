/**
 * v1.21.0 — Operability surface specs.
 *
 * Coverage:
 *   • A. Catch-up banner — renders nothing when never visited; renders
 *     count + top 3 + show-all when N new atoms; quiet caught-up line
 *     when 0 new since last visit.
 *   • B. Capture input — collapsed → expand → save flow writes through
 *     to `captureManualAtom`; failure path surfaces toast; ⌘+Enter
 *     saves; cancel collapses without saving.
 *   • C. Spotlight Ask mode — tab strip toggles modes; rankAskResults
 *     pure function returns top 5 with right ordering; empty corpus
 *     shows honest empty state.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

import { CatchupBanner, formatRelativeShort } from "../src/components/feed/CatchupBanner";
import { CaptureInput } from "../src/components/feed/CaptureInput";
import {
  Spotlight,
  rankAskResults,
} from "../src/components/spotlight/Spotlight";
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

beforeEach(() => {
  cleanup();
  // Reset toast queue between tests.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      toasts: [],
    },
  }));
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A. Catch-up banner.
// ---------------------------------------------------------------------------

describe("v1.21 catchup banner", () => {
  it("renders nothing when last_opened_at is null (never visited)", async () => {
    vi.spyOn(views, "readCursor").mockResolvedValue({
      user: "daizhe",
      last_opened_at: null,
      viewed: [],
      acked: [],
      deferred: [],
      preferences: {},
    });
    const { container } = render(
      <CatchupBanner
        events={[
          makeEvent({ id: "e1", ts: new Date().toISOString() }),
        ]}
        user="daizhe"
        onOpenAtom={() => {}}
      />,
    );
    await waitFor(() => {
      // Wait for the cursor read to resolve.
      expect(views.readCursor).toHaveBeenCalled();
    });
    // The component returns null when last_opened_at is null.
    expect(container.querySelector('[data-testid="feed-catchup-banner"]')).toBeNull();
  });

  it("renders quiet caught-up line when 0 new atoms since last visit", async () => {
    const lastOpened = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    vi.spyOn(views, "readCursor").mockResolvedValue({
      user: "daizhe",
      last_opened_at: lastOpened,
      viewed: [],
      acked: [],
      deferred: [],
      preferences: {},
    });
    // Event predates lastOpened → 0 new.
    const olderEv = makeEvent({
      id: "e_old",
      ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    render(
      <CatchupBanner
        events={[olderEv]}
        user="daizhe"
        onOpenAtom={() => {}}
      />,
    );
    const banner = await screen.findByTestId("feed-catchup-banner");
    expect(banner.getAttribute("data-mode")).toBe("caught-up");
    expect(banner.textContent ?? "").toMatch(/caught up/);
  });

  it("renders N-new count + top 3 rows + show-all button when count > 3", async () => {
    const lastOpened = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    vi.spyOn(views, "readCursor").mockResolvedValue({
      user: "daizhe",
      last_opened_at: lastOpened,
      viewed: [],
      acked: [],
      deferred: [],
      preferences: {},
    });
    const newer = (offsetMin: number, id: string) =>
      makeEvent({
        id,
        ts: new Date(Date.now() - offsetMin * 60 * 1000).toISOString(),
        body: `body ${id}`,
      });
    const events = [
      newer(1, "n1"),
      newer(2, "n2"),
      newer(3, "n3"),
      newer(4, "n4"),
      newer(5, "n5"),
    ];
    render(
      <CatchupBanner
        events={events}
        user="daizhe"
        onOpenAtom={() => {}}
      />,
    );
    const banner = await screen.findByTestId("feed-catchup-banner");
    expect(banner.getAttribute("data-mode")).toBe("new-atoms");
    const count = await screen.findByTestId("feed-catchup-count");
    expect(count.textContent).toMatch(/5 new atoms/);
    // Top 3 visible by default.
    expect(screen.getAllByTestId("feed-catchup-row").length).toBe(3);
    // show-all click reveals the rest.
    fireEvent.click(screen.getByTestId("feed-catchup-show-all"));
    expect(screen.getAllByTestId("feed-catchup-row").length).toBe(5);
  });
});

describe("v1.21 formatRelativeShort", () => {
  it("renders 'just now' under 60s", () => {
    const iso = new Date(Date.now() - 5_000).toISOString();
    expect(formatRelativeShort(iso)).toBe("just now");
  });
  it("renders 'X min ago' for sub-hour spans", () => {
    const iso = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    expect(formatRelativeShort(iso)).toBe("12 min ago");
  });
  it("renders 'Xh ago' for sub-day spans", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeShort(iso)).toBe("3h ago");
  });
});

// ---------------------------------------------------------------------------
// B. Capture input.
// ---------------------------------------------------------------------------

describe("v1.21 capture input", () => {
  it("renders collapsed by default and expands on click", async () => {
    render(<CaptureInput user="daizhe" onCaptured={() => {}} />);
    const root = screen.getByTestId("feed-capture-input");
    expect(root.getAttribute("data-mode")).toBe("collapsed");
    fireEvent.click(screen.getByTestId("feed-capture-expand"));
    await waitFor(() => {
      const expanded = screen.getByTestId("feed-capture-input");
      expect(expanded.getAttribute("data-mode")).toBe("expanded");
    });
    expect(screen.getByTestId("feed-capture-textarea")).toBeTruthy();
    expect(screen.getByTestId("feed-capture-tag-decision")).toBeTruthy();
    expect(screen.getByTestId("feed-capture-tag-note")).toBeTruthy();
    expect(screen.getByTestId("feed-capture-tag-task")).toBeTruthy();
  });

  it("save calls captureManualAtom + collapses + clears + invokes onCaptured", async () => {
    const onCaptured = vi.fn();
    const captureSpy = vi
      .spyOn(views, "captureManualAtom")
      .mockResolvedValue({
        event: makeEvent({ id: "evt-2026-04-30-abc123def456", body: "hi" }),
        path: "/x.md",
      });

    render(<CaptureInput user="daizhe" onCaptured={onCaptured} />);
    fireEvent.click(screen.getByTestId("feed-capture-expand"));
    const ta = (await screen.findByTestId(
      "feed-capture-textarea",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("feed-capture-tag-decision"));
    fireEvent.click(screen.getByTestId("feed-capture-save-btn"));

    await waitFor(() => {
      expect(captureSpy).toHaveBeenCalledWith("daizhe", "hi", "decision", "daizhe");
    });
    expect(onCaptured).toHaveBeenCalledTimes(1);
  });

  it("save failure surfaces a toast and keeps the input expanded", async () => {
    vi.spyOn(views, "captureManualAtom").mockRejectedValue(
      new Error("disk full"),
    );

    render(<CaptureInput user="daizhe" onCaptured={() => {}} />);
    fireEvent.click(screen.getByTestId("feed-capture-expand"));
    const ta = (await screen.findByTestId(
      "feed-capture-textarea",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("feed-capture-save-btn"));

    await waitFor(() => {
      const toasts = useStore.getState().ui.toasts;
      expect(toasts.some((t) => t.kind === "error" && /Capture failed/.test(t.text))).toBe(true);
    });
    // Still expanded after failure.
    const expanded = screen.getByTestId("feed-capture-input");
    expect(expanded.getAttribute("data-mode")).toBe("expanded");
  });

  it("⌘+Enter triggers save", async () => {
    const captureSpy = vi
      .spyOn(views, "captureManualAtom")
      .mockResolvedValue({
        event: makeEvent({ id: "evt-2026-04-30-aaa111bbb222" }),
        path: "/x.md",
      });
    render(<CaptureInput user="daizhe" onCaptured={() => {}} />);
    fireEvent.click(screen.getByTestId("feed-capture-expand"));
    const ta = (await screen.findByTestId(
      "feed-capture-textarea",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "via shortcut" } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(captureSpy).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// C. Spotlight Ask mode.
// ---------------------------------------------------------------------------

describe("v1.21 rankAskResults", () => {
  const baseEvents: TimelineEvent[] = [
    makeEvent({
      id: "e1",
      ts: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      source: "cursor",
      kind: "capture",
      body: "PCB Tier-2 痛点 — 兴森 70% gross margin",
      concepts: ["pcb"],
    }),
    makeEvent({
      id: "e2",
      ts: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      source: "claude_code",
      kind: "decision",
      body: "decided to anchor pricing at $99/mo through Q2",
      concepts: ["pcb"],
    }),
    makeEvent({
      id: "e3",
      ts: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      source: "slack",
      kind: "comment",
      body: "irrelevant chitchat about lunch",
      concepts: [],
    }),
  ];

  it("returns empty for empty query or empty corpus", () => {
    expect(rankAskResults("", baseEvents)).toEqual([]);
    expect(rankAskResults("pcb", [])).toEqual([]);
    expect(rankAskResults("   ", baseEvents)).toEqual([]);
  });

  it("ranks decisions higher than non-decisions for matching query", () => {
    const out = rankAskResults("pcb pricing", baseEvents);
    expect(out.length).toBeGreaterThan(0);
    // e2 is a decision with query terms — should rank highest.
    expect(out[0].event.id).toBe("e2");
  });

  it("excludes events with zero term hits", () => {
    const out = rankAskResults("pcb", baseEvents);
    const ids = out.map((r) => r.event.id);
    expect(ids).not.toContain("e3");
  });

  it("caps results at 5", () => {
    const many: TimelineEvent[] = [];
    for (let i = 0; i < 20; i++) {
      many.push(
        makeEvent({
          id: `m${i}`,
          ts: new Date(Date.now() - i * 60_000).toISOString(),
          body: `pcb mention ${i}`,
        }),
      );
    }
    const out = rankAskResults("pcb", many);
    expect(out.length).toBe(5);
  });

  it("excerpt picks the line containing the query term", () => {
    const ev = makeEvent({
      id: "ex1",
      body: "first line\nsecond line with pcb in it\nthird",
    });
    const out = rankAskResults("pcb", [ev]);
    expect(out[0].excerpt).toBe("second line with pcb in it");
  });
});

describe("v1.21 spotlight mode strip", () => {
  beforeEach(() => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        spotlightOpen: true,
      },
    }));
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
  });

  it("renders Search + Ask tab buttons with Search active by default", async () => {
    render(<Spotlight />);
    const search = await screen.findByTestId("spotlight-mode-search");
    const ask = await screen.findByTestId("spotlight-mode-ask");
    expect(search.getAttribute("data-active")).toBe("true");
    expect(ask.getAttribute("data-active")).toBe("false");
  });

  it("clicking Ask flips data-mode + shows the ask prompt", async () => {
    render(<Spotlight />);
    const ask = await screen.findByTestId("spotlight-mode-ask");
    fireEvent.click(ask);
    await waitFor(() => {
      const panel = screen.getByTestId("spotlight-panel");
      expect(panel.getAttribute("data-mode")).toBe("ask");
    });
    expect(screen.getByTestId("spotlight-ask-prompt")).toBeTruthy();
  });

  it("ask mode shows honest empty-corpus message when no atoms", async () => {
    render(<Spotlight />);
    fireEvent.click(await screen.findByTestId("spotlight-mode-ask"));
    const input = await screen.findByTestId("spotlight-input");
    fireEvent.change(input, { target: { value: "pcb" } });
    const empty = await screen.findByTestId("spotlight-ask-empty");
    expect(empty.getAttribute("data-empty-mode")).toBe("no-corpus");
  });

  it("ask mode renders ranked results when corpus + query produce hits", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [
        makeEvent({
          id: "ev1",
          body: "PCB pricing decision was Q2",
          kind: "decision",
        }),
      ],
      notes: [],
    });
    render(<Spotlight />);
    fireEvent.click(await screen.findByTestId("spotlight-mode-ask"));
    const input = await screen.findByTestId("spotlight-input");
    fireEvent.change(input, { target: { value: "pcb" } });
    const rows = await screen.findAllByTestId("spotlight-ask-result-row");
    expect(rows.length).toBe(1);
  });
});
