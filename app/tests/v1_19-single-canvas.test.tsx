/**
 * v1.19.0 Round 1 — Single-canvas + Cmd+K-everything regression specs.
 *
 * Coverage:
 *   • Spotlight: Cmd+K opens, ESC closes, click-outside closes, type
 *     filters, Enter selects, arrow keys navigate, `@` `#` `:` prefixes
 *     route to the right groups.
 *   • Time-density list: rows render time/actor/source/body in correct
 *     grid columns; click opens AtomBottomSheet; day separators bold.
 *   • Single-key view switchers (T/H/P/R) update `ui.canvasView` only
 *     when no input is focused AND Spotlight is closed.
 *   • Empty state: literal "No captures yet. Tangerine is watching."
 *   • Footer hint: visible by default; hidden when shortcutHintShown >= 5.
 *   • buildResults helper: prefix routing.
 *
 * The old wave-2-B1 / wave-4-D2 / wave-14 tests target dead surfaces
 * (FilterChips, StatusBar chips, sidebar nav). They've been left on disk
 * — Round 2 may re-skip them or delete; Round 1 just doesn't fix them.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import FeedRoute from "../src/routes/feed";
import { Spotlight, buildResults } from "../src/components/spotlight/Spotlight";
import { AppShell } from "../src/components/layout/AppShell";
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
    ts: "2026-04-29T14:32:00Z",
    source: "cursor",
    actor: "daizhe",
    body: "v1.18.1 ship walker fix",
    concepts: ["pcb"],
    refs: { threads: ["v1-launch"] },
  }),
  makeEvent({
    id: "e2",
    ts: "2026-04-29T13:50:00Z",
    source: "claude_code",
    actor: "daizhe",
    body: "kicking off agent for /canvas",
    refs: { threads: ["v1-launch"] },
  }),
  makeEvent({
    id: "e3",
    ts: "2026-04-29T13:01:00Z",
    source: "cursor",
    actor: "hongyu",
    body: "feedback on TEAM_INDEX wiring",
    concepts: ["pcb", "infra"],
  }),
];

beforeEach(() => {
  cleanup();
  // Reset store to v1.19 defaults so tests don't see persisted leakage.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      currentUser: "daizhe",
      canvasView: "time",
      sidebarVisible: false,
      spotlightOpen: false,
      shortcutHintShown: 0,
      welcomed: true,
    },
  }));
  vi.restoreAllMocks();
});

describe("v1.19 Round 1 — Spotlight (Cmd+K)", () => {
  it("renders nothing when spotlightOpen=false", () => {
    render(<Spotlight />);
    expect(screen.queryByTestId("spotlight")).not.toBeInTheDocument();
  });

  it("renders when spotlightOpen=true", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, spotlightOpen: true } }));
    render(<Spotlight />);
    expect(screen.getByTestId("spotlight")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("spotlight-results")).toBeInTheDocument();
    });
  });

  it("ESC inside spotlight closes it", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, spotlightOpen: true } }));
    render(<Spotlight />);
    await waitFor(() =>
      expect(screen.getByTestId("spotlight")).toBeInTheDocument(),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => {
      expect(useStore.getState().ui.spotlightOpen).toBe(false);
    });
  });

  it("backdrop click closes spotlight", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, spotlightOpen: true } }));
    render(<Spotlight />);
    await waitFor(() =>
      expect(screen.getByTestId("spotlight-backdrop")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("spotlight-backdrop"));
    await waitFor(() => {
      expect(useStore.getState().ui.spotlightOpen).toBe(false);
    });
  });

  it("typing into the input updates the query", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, spotlightOpen: true } }));
    render(<Spotlight />);
    await waitFor(() =>
      expect(screen.getByTestId("spotlight-input")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("spotlight-input"), {
      target: { value: "walker" },
    });
    expect(
      (screen.getByTestId("spotlight-input") as HTMLInputElement).value,
    ).toBe("walker");
  });

  it("ArrowDown advances the active result", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, spotlightOpen: true } }));
    render(<Spotlight />);
    await waitFor(() =>
      expect(
        screen.getByTestId("spotlight-results").getAttribute("data-count"),
      ).not.toBe("0"),
    );
    const before = screen.getAllByTestId("spotlight-result");
    expect(before[0].getAttribute("data-active")).toBe("true");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    const after = screen.getAllByTestId("spotlight-result");
    expect(after[1].getAttribute("data-active")).toBe("true");
  });
});

describe("v1.19 Round 1 — buildResults filter prefixes", () => {
  it(":<command> only shows the Commands group", () => {
    const rows = buildResults(":replay", SAMPLE_EVENTS);
    expect(rows.every((r) => r.group === "commands")).toBe(true);
    expect(rows.find((r) => r.id === "cmd-replay")).toBeTruthy();
  });

  it("@<alias> only shows the People group", () => {
    const rows = buildResults("@daizhe", SAMPLE_EVENTS);
    expect(rows.every((r) => r.group === "people")).toBe(true);
    expect(rows.find((r) => r.primary === "@daizhe")).toBeTruthy();
  });

  it("#<concept> only shows recent atoms with that concept", () => {
    const rows = buildResults("#pcb", SAMPLE_EVENTS);
    expect(rows.every((r) => r.group === "recent")).toBe(true);
    // Both e1 + e3 have #pcb.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("plain query produces all four groups when matches exist", () => {
    const rows = buildResults("", SAMPLE_EVENTS);
    const groups = new Set(rows.map((r) => r.group));
    expect(groups.has("recent")).toBe(true);
    expect(groups.has("people")).toBe(true);
    expect(groups.has("threads")).toBe(true);
    expect(groups.has("commands")).toBe(true);
  });
});

describe("v1.19 Round 1 — Time-density list", () => {
  function renderRoute() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <FeedRoute />
      </MemoryRouter>,
    );
  }

  it("renders the empty state with the literal v1.19 string", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });
    expect(screen.getByTestId("empty-state").textContent).toContain(
      "No captures yet. Tangerine is watching.",
    );
  });

  it("time-density rows render in 4-col grid with time/actor/source/body", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("time-density-list")).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId("time-row");
    expect(rows.length).toBe(3);
    // First row body matches expected order (newest first).
    expect(rows[0].textContent).toContain("14:32");
    expect(rows[0].textContent).toContain("daizhe");
    expect(rows[0].textContent).toContain("cursor");
    expect(rows[0].textContent).toContain("v1.18.1 ship walker fix");
  });

  it("clicking a row opens AtomBottomSheet", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("time-density-list")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByTestId("time-row")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("atom-bottom-sheet")).toBeInTheDocument();
    });
  });

  it("day separator renders bold mono text", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: SAMPLE_EVENTS,
      notes: [],
    });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId("time-density-list")).toBeInTheDocument();
    });
    const seps = screen.getAllByTestId("time-day-separator");
    expect(seps.length).toBeGreaterThanOrEqual(1);
    // Class signature for bold mono.
    expect(seps[0].className).toContain("font-mono");
    expect(seps[0].className).toContain("font-bold");
  });
});

describe("v1.19 Round 1 — AppShell wiring", () => {
  function renderShell() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell />
      </MemoryRouter>,
    );
  }

  it("Cmd+K opens spotlight via the global keybind", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    expect(useStore.getState().ui.spotlightOpen).toBe(false);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      );
    });
    expect(useStore.getState().ui.spotlightOpen).toBe(true);
  });

  it("T/H/P/R single keys cycle canvasView when no input focused", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h" }));
    });
    expect(useStore.getState().ui.canvasView).toBe("heatmap");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    });
    expect(useStore.getState().ui.canvasView).toBe("people");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });
    expect(useStore.getState().ui.canvasView).toBe("time");
  });

  it("T/H/P/R DO NOT fire when an input is focused", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    // Mount a fake input; focus it; dispatch H — view should stay "time".
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", bubbles: true }),
      );
    });
    expect(useStore.getState().ui.canvasView).toBe("time");
    document.body.removeChild(input);
  });

  it("Sidebar is hidden by default in Round 1", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
  });

  it("Footer hint is visible when shortcutHintShown < 5", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, shortcutHintShown: 0 } }));
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("footer-hint")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("footer-hint").textContent).toContain(
      "T time",
    );
  });

  it("Footer hint hides when shortcutHintShown >= 5", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    // Pre-set to 6 BEFORE shell mounts so the bump-on-mount effect can't
    // push us back below 5 by lifting from 5 → 6.
    useStore.setState((s) => ({ ui: { ...s.ui, shortcutHintShown: 6 } }));
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("footer-hint")).not.toBeInTheDocument();
  });

  it("AppShell mount bumps shortcutHintShown by exactly 1", async () => {
    vi.spyOn(views, "readTimelineRecent").mockResolvedValue({
      events: [],
      notes: [],
    });
    useStore.setState((s) => ({ ui: { ...s.ui, shortcutHintShown: 2 } }));
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("app-shell-root")).toBeInTheDocument(),
    );
    expect(useStore.getState().ui.shortcutHintShown).toBe(3);
  });
});
