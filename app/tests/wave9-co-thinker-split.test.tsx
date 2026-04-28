// === wave 9 ===
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CoThinkerRoute from "../src/routes/co-thinker";
import * as tauri from "../src/lib/tauri";

const SAMPLE_BRAIN = `# Co-thinker

## What I'm watching
- Pricing thread is thrashing
- See /memory/decisions/sample-pricing-20-seat.md L23 for the latest call.

## Active threads
- pricing-tier-2

## My todo
1. Re-read /memory/threads/pricing-tier-2.md.
`;

describe("Wave 9 — co-thinker split view", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, "coThinkerReadBrain").mockResolvedValue(SAMPLE_BRAIN);
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: SAMPLE_BRAIN.length,
      observations_today: 4,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default mode = split (preview + source side-by-side)", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("co-thinker-split-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("co-thinker-split-source")).toBeInTheDocument();
    expect(screen.getByTestId("co-thinker-view-toggle")).toBeInTheDocument();
  });

  it("clicking 'Source' switches to source-only view", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("view-mode-source")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("view-mode-source"));
    expect(screen.getByTestId("co-thinker-source-only")).toBeInTheDocument();
    expect(screen.queryByTestId("co-thinker-split-preview")).not.toBeInTheDocument();
  });

  it("clicking 'Preview' switches to preview-only view", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("view-mode-preview")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("view-mode-preview"));
    expect(screen.queryByTestId("co-thinker-split-source")).not.toBeInTheDocument();
    expect(screen.queryByTestId("co-thinker-source-only")).not.toBeInTheDocument();
    // Brain (sections) still renders.
    expect(screen.getByTestId("co-thinker-brain")).toBeInTheDocument();
  });

  it("Cited atoms grounding section renders an AtomCard per citation", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("co-thinker-grounding")).toBeInTheDocument();
    });
    // SAMPLE_BRAIN has 2 distinct citations.
    expect(screen.getByTestId("grounding-atom-0")).toBeInTheDocument();
    expect(screen.getByTestId("grounding-atom-1")).toBeInTheDocument();
  });

  it("heartbeat ribbon dot is rendered with vendor data attribute", async () => {
    render(
      <MemoryRouter>
        <CoThinkerRoute />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("heartbeat-ribbon-dot")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("heartbeat-ribbon-dot").hasAttribute("data-vendor"),
    ).toBe(true);
  });
});
// === end wave 9 ===
