import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CoThinkerRoute from "../src/routes/co-thinker";
import * as tauri from "../src/lib/tauri";
import {
  CITATION_REGEX,
  parseSections,
  relativeTime,
  citationToRoute,
} from "../src/lib/co-thinker";
// === v1.15.0 Wave 2.2 === — these legacy tests assert on the
// returning-user explainer (the original "This is your team's shared
// brain" pre-init card). Wave 2.2 wraps the empty branch with a fresh-
// user EmptyStateCard gated on `firstAtomCapturedAt === null`, so these
// tests must flip the latch to a non-null timestamp before render to
// keep exercising the legacy explainer path.
import { useStore } from "../src/lib/store";

const SAMPLE_BRAIN = `# Co-thinker

## What I'm watching
- Pricing thread is thrashing
- See /memory/decisions/sample-pricing-20-seat.md L23 for the latest call.

## Active threads
- pricing-tier-2
- launch-blockers — last touched 12h ago.

## My todo
1. Re-read /memory/threads/pricing-tier-2.md and propose a tie-break.
2. Draft a brief for the Monday standup.

## Recent reasoning
The team disagreed on per-seat vs flat-rate. Daizhe's note on
/memory/people/daizhe.md L12 indicates he favors the flat rate.
`;

describe("co-thinker library helpers", () => {
  describe("CITATION_REGEX", () => {
    it("matches a path with no line number", () => {
      const m = SAMPLE_BRAIN.match(/\/memory\/threads\/pricing-tier-2\.md/);
      expect(m).not.toBeNull();
    });

    it("matches a path with a line number", () => {
      const re = new RegExp(CITATION_REGEX.source, "g");
      const matches = Array.from(SAMPLE_BRAIN.matchAll(re));
      // The doc has 3 citations: 2 with line numbers, 1 without.
      expect(matches.length).toBe(3);
      const withLines = matches.filter((m) => m[2] !== undefined);
      expect(withLines.length).toBe(2);
    });
  });

  describe("relativeTime", () => {
    it("returns '—' for null", () => {
      expect(relativeTime(null)).toBe("—");
    });

    it("returns '—' for unparseable input", () => {
      expect(relativeTime("not-a-date")).toBe("—");
    });

    it("returns 'just now' within 5s", () => {
      const now = new Date("2026-04-26T12:00:00Z");
      const t = new Date("2026-04-26T11:59:58Z").toISOString();
      expect(relativeTime(t, now)).toBe("just now");
    });

    it("formats minutes-ago", () => {
      const now = new Date("2026-04-26T12:00:00Z");
      const t = new Date("2026-04-26T11:55:00Z").toISOString();
      expect(relativeTime(t, now)).toBe("5 min ago");
    });

    it("formats hours-ago", () => {
      const now = new Date("2026-04-26T12:00:00Z");
      const t = new Date("2026-04-26T10:00:00Z").toISOString();
      expect(relativeTime(t, now)).toBe("2 hr ago");
    });

    it("formats future (next heartbeat)", () => {
      const now = new Date("2026-04-26T12:00:00Z");
      const t = new Date("2026-04-26T12:04:00Z").toISOString();
      expect(relativeTime(t, now)).toBe("in 4 min");
    });
  });

  describe("parseSections", () => {
    it("returns the four canonical sections", () => {
      const sections = parseSections(SAMPLE_BRAIN);
      const headings = sections.map((s) => s.heading);
      expect(headings).toEqual([
        "What I'm watching",
        "Active threads",
        "My todo",
        "Recent reasoning",
      ]);
    });

    it("returns [] for empty doc", () => {
      expect(parseSections("")).toEqual([]);
    });

    it("preserves bullet bodies", () => {
      const sections = parseSections(SAMPLE_BRAIN);
      const watching = sections[0];
      expect(watching.body).toContain("Pricing thread is thrashing");
      expect(watching.body).toContain("/memory/decisions/sample-pricing-20-seat.md L23");
    });
  });

  describe("citationToRoute", () => {
    it("passes through a /memory/ path unchanged", () => {
      expect(citationToRoute("/memory/decisions/foo.md")).toBe(
        "/memory/decisions/foo.md",
      );
    });

    it("adds a leading slash to memory/ paths", () => {
      expect(citationToRoute("memory/decisions/foo.md")).toBe(
        "/memory/decisions/foo.md",
      );
    });

    it("falls through bare paths under /memory/", () => {
      expect(citationToRoute("decisions/foo.md")).toBe(
        "/memory/decisions/foo.md",
      );
    });
  });
});

describe("CoThinkerRoute", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state when brain doc empty", async () => {
    // === v1.15.0 Wave 2.2 === — exercise the returning-user path so
    // the legacy explainer ("This is your team's shared brain") still
    // renders. First-time users hit the new EmptyStateCard via Wave 2.2.
    useStore.getState().ui.setFirstAtomCapturedAt(Date.now());
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue("");
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    await waitFor(() => {
      // === wave 12 === — explainer lede changed: "AGI brain" → "shared
      // brain" (Wave 12 drops AGI prefix in user UI). Initialize button
      // label tracks the new "Initialize team brain" copy.
      expect(
        screen.getByText(/This is your team's shared brain/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Initialize team brain/i }),
    ).toBeInTheDocument();
  });

  // Wave 4-C — co-thinker explainer pre-init.
  it("explainer card surfaces 4 design pillars before init", async () => {
    // === v1.15.0 Wave 2.2 === — flip latch so the legacy 4-pillar
    // explainer renders (returning-user path). First-time users see
    // the lighter EmptyStateCard.
    useStore.getState().ui.setFirstAtomCapturedAt(Date.now());
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue("");
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("co-thinker-explainer")).toBeInTheDocument();
    });
    const card = screen.getByTestId("co-thinker-explainer");
    // 4 pillars: read / edit / git-diff / no new subscription.
    expect(card.textContent).toMatch(/Read/i);
    expect(card.textContent).toMatch(/Edit/i);
    expect(card.textContent).toMatch(/git-diff/i);
    expect(card.textContent).toMatch(/No new subscription/i);
    // Heartbeat cadence + steering message must show up too.
    expect(card.textContent).toMatch(/every 5 minutes/i);
    expect(card.textContent).toMatch(/30 minutes when you're idle/i);
  });

  it("renders 4 sections from sample brain doc", async () => {
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      next_heartbeat_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      brain_doc_size: SAMPLE_BRAIN.length,
      observations_today: 7,
    });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    // Wait for the section cards to render.
    await waitFor(() => {
      expect(screen.getByText("What I'm watching")).toBeInTheDocument();
    });
    expect(screen.getByText("Active threads")).toBeInTheDocument();
    expect(screen.getByText("My todo")).toBeInTheDocument();
    expect(screen.getByText("Recent reasoning")).toBeInTheDocument();
  });

  it("citation links are clickable and route to /memory/...", async () => {
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date().toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: SAMPLE_BRAIN.length,
      observations_today: 0,
    });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const links = screen.getAllByTestId("citation-link");
      expect(links.length).toBeGreaterThanOrEqual(3);
    });
    const links = screen.getAllByTestId("citation-link") as HTMLAnchorElement[];
    // Every citation link should target a /memory/<path> route.
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^\/memory\//);
    }
    // Spot-check the first one points to the pricing decision file.
    expect(
      links.some((a) =>
        a.getAttribute("href")?.endsWith("/memory/decisions/sample-pricing-20-seat.md"),
      ),
    ).toBe(true);
  });

  it("edit toggle reveals textarea and exposes save / cancel", async () => {
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date().toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: SAMPLE_BRAIN.length,
      observations_today: 0,
    });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Edit brain doc/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Edit brain doc/i }));

    const editor = await screen.findByTestId("co-thinker-editor");
    const textarea = within(editor).getByLabelText(
      /Edit brain doc/i,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain("What I'm watching");
    expect(within(editor).getByRole("button", { name: /Save/i })).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
  });

  it("manual trigger calls coThinkerTriggerHeartbeat", async () => {
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date().toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: SAMPLE_BRAIN.length,
      observations_today: 0,
    });
    const trigger = vi
      .spyOn(tauri, "coThinkerTriggerHeartbeat")
      .mockResolvedValue({
        atoms_seen: 4,
        brain_updated: true,
        proposals_created: 1,
        channel_used: "mcp",
        latency_ms: 412,
        error: null,
      });

    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );

    await waitFor(() => {
      // === wave 12 === — manual trigger button copy "Trigger heartbeat now"
      // → "Sync now" (Wave 12 hides heartbeat jargon in user UI). The
      // underlying Tauri command name stays `coThinkerTriggerHeartbeat`.
      expect(
        screen.getByRole("button", { name: /Sync now/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Sync now/i }));

    await waitFor(() => {
      expect(trigger).toHaveBeenCalledTimes(1);
    });
  });
});
