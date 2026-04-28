// === wave 21 ===
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CoThinkerRoute from "../src/routes/co-thinker";
import * as tauri from "../src/lib/tauri";

const SAMPLE_BRAIN = `# Co-thinker

## What I'm watching
- PCB Tier 2 [[PCB-Tier-2]]
- Pricing shift [[Pricing-Shift]]
- Flag rollout [[Flag-Rollout]]
- See /memory/decisions/pricing.md L23 for the latest call.

## Active threads
- pricing-tier-2

## My todo
1. Re-read /memory/threads/pricing-tier-2.md.

## Recent reasoning
The team disagreed on per-seat vs flat-rate.
`;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
  vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
    last_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    next_heartbeat_at: null,
    brain_doc_size: SAMPLE_BRAIN.length,
    observations_today: 4,
  });
  vi.spyOn(tauri, "computeBacklinks").mockResolvedValue({
    target_path: "team/co-thinker.md",
    target_title: "co-thinker",
    hits: [
      {
        path: "team/decisions/2026-04-22-pcb-tier2.md",
        title: "PCB Tier 2 supplier",
        snippet: "…brain doc cited team/co-thinker.md as the canonical source…",
      },
      {
        path: "team/decisions/2026-04-26-pricing.md",
        title: "Pricing shift",
        snippet: "…see team/co-thinker.md for context…",
      },
    ],
  });
  vi.spyOn(tauri, "gitLogForFile").mockResolvedValue([
    {
      sha: "a1b2c3d",
      message: "brain refreshed (cursor)",
      ts: new Date(Date.now() - 2 * 60_000).toISOString(),
      author: "alex",
    },
    {
      sha: "deadbee",
      message: "brain refreshed (cursor)",
      ts: new Date(Date.now() - 8 * 60_000).toISOString(),
      author: "alex",
    },
    {
      sha: "cafe123",
      message: "brain refreshed (claude-code)",
      ts: new Date(Date.now() - 60 * 60_000).toISOString(),
      author: "sam",
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 21 — /brain editor polish", () => {
  it("preserves the wave 9 split-view default", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("co-thinker-split-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("co-thinker-split-source")).toBeInTheDocument();
  });

  it("renders the inline history strip with commits", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("brain-history")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("brain-history-a1b2c3d")).toBeInTheDocument();
    });
    expect(screen.getByTestId("brain-history-deadbee")).toBeInTheDocument();
    expect(screen.getByTestId("brain-history-cafe123")).toBeInTheDocument();
  });

  it("renders backlinks section with citing atoms", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("brain-backlinks")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("brain-backlink-team/decisions/2026-04-22-pcb-tier2.md"),
      ).toBeInTheDocument();
    });
  });

  it("renders [[link]] wiki-style citations as clickable WikiLink components", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("brain-wikilink").length).toBeGreaterThan(0);
    });
    const links = screen.getAllByTestId("brain-wikilink");
    const titles = links.map((el) => el.getAttribute("data-title"));
    expect(titles).toContain("PCB-Tier-2");
    expect(titles).toContain("Pricing-Shift");
    expect(titles).toContain("Flag-Rollout");
    // Each is rendered as an <a> via react-router Link.
    expect(links[0].tagName.toLowerCase()).toBe("a");
  });

  it("renders empty backlinks state when computeBacklinks returns no hits", async () => {
    vi.spyOn(tauri, "computeBacklinks").mockResolvedValue({
      target_path: "team/co-thinker.md",
      target_title: "co-thinker",
      hits: [],
    });
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("brain-backlinks")).toBeInTheDocument();
    });
    expect(screen.getByText(/no atoms cite this brain doc yet/i)).toBeInTheDocument();
  });

  it("renders empty history state when gitLogForFile returns nothing", async () => {
    vi.spyOn(tauri, "gitLogForFile").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("brain-history")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/no commits yet/i)).toBeInTheDocument();
    });
  });
});
// === end wave 21 ===
