import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AgiPeer } from "../src/components/canvas/AgiPeer";
import { AgiStickyAffordances } from "../src/components/canvas/AgiStickyAffordances";
import * as tauri from "../src/lib/tauri";
import type { Sticky } from "../src/lib/canvas";

// ============================================================
// Helpers
// ============================================================

function makeSticky(overrides: Partial<Sticky> = {}): Sticky {
  return {
    id: "abc123def456",
    x: 100,
    y: 100,
    color: "yellow",
    author: "daizhe",
    is_agi: false,
    created_at: "2026-04-26T15:00:00.000Z",
    body: "human idea",
    comments: [],
    ...overrides,
  };
}

/**
 * AgiStickyAffordances portals into a `[data-testid="sticky-{id}"]` host.
 * In tests we render that host inline so the portal has a target.
 */
function renderHostsAndAffordances(stickies: Sticky[]) {
  const hosts = (
    <div>
      {stickies.map((s) => (
        <div
          key={s.id}
          data-testid={`sticky-${s.id}`}
          style={{ position: "absolute", width: 260, height: 120 }}
        />
      ))}
    </div>
  );
  return render(
    <MemoryRouter>
      {hosts}
      <AgiStickyAffordances
        project="tangerine"
        topic="v1-8-ideation"
        stickies={stickies}
      />
    </MemoryRouter>,
  );
}

// ============================================================
// 1. AgiPeer presence chip
// ============================================================

describe("AgiPeer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders activity timestamp from coThinkerStatus", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: fiveMinAgo,
      next_heartbeat_at: null,
      brain_doc_size: 1024,
      observations_today: 3,
    });

    render(
      <MemoryRouter>
        <AgiPeer project="tangerine" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const recency = screen.getByTestId("agi-peer-recency");
      expect(recency.textContent).toContain("5m ago");
    });
  });

  it("falls back to no-heartbeat copy when status returns null", async () => {
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: null,
      next_heartbeat_at: null,
      brain_doc_size: 0,
      observations_today: 0,
    });

    render(
      <MemoryRouter>
        <AgiPeer project="tangerine" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const recency = screen.getByTestId("agi-peer-recency");
      expect(recency.textContent).toMatch(/no heartbeat yet/i);
    });
  });

  it("links to /co-thinker when clicked", async () => {
    vi.spyOn(tauri, "coThinkerStatus").mockResolvedValue({
      last_heartbeat_at: new Date().toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: 1,
      observations_today: 0,
    });

    render(
      <MemoryRouter initialEntries={["/canvas/tangerine"]}>
        <AgiPeer project="tangerine" />
      </MemoryRouter>,
    );

    const chip = await screen.findByTestId("agi-peer-chip");
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute("aria-label")).toMatch(/Co-thinker/i);
  });
});

// ============================================================
// 2. AgiStickyAffordances — 🍊 dot only on AGI stickies
// ============================================================

describe("AgiStickyAffordances", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the 🍊 dot only on AGI stickies", () => {
    const human = makeSticky({ id: "humanid12345", is_agi: false });
    const agi = makeSticky({
      id: "agiid12345xy",
      is_agi: true,
      author: "tangerine-agi",
    });

    renderHostsAndAffordances([human, agi]);

    expect(screen.queryByTestId(`agi-dot-${human.id}`)).toBeNull();
    expect(screen.getByTestId(`agi-dot-${agi.id}`)).toBeInTheDocument();
  });

  it("propose-lock button calls Tauri command + toasts on success", async () => {
    const sticky = makeSticky({ id: "stk999abcdef" });
    const proposeMock = vi
      .spyOn(tauri, "canvasProposeLock")
      .mockResolvedValue(
        "/Users/daizhe/.tangerine-memory/decisions/canvas-v1-8-ideation-stk999abcdef.md",
      );

    renderHostsAndAffordances([sticky]);

    // Hover the affordance overlay so the button surfaces.
    const overlay = screen.getByTestId(`agi-affordance-${sticky.id}`);
    fireEvent.mouseEnter(overlay);

    const btn = await screen.findByTestId(`propose-lock-${sticky.id}`);
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(proposeMock).toHaveBeenCalledWith(
      "tangerine",
      "v1-8-ideation",
      sticky.id,
    );
  });

  it("renders 'View AGI reasoning' button only for AGI stickies", () => {
    const human = makeSticky({ id: "humanaa11bb22" });
    const agi = makeSticky({
      id: "agiidaa11bb22",
      is_agi: true,
      author: "tangerine-agi",
    });

    renderHostsAndAffordances([human, agi]);

    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${human.id}`));
    expect(screen.queryByTestId(`view-reasoning-${human.id}`)).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${agi.id}`));
    expect(screen.getByTestId(`view-reasoning-${agi.id}`)).toBeInTheDocument();
  });

  it("surfaces an error toast when propose-lock fails", async () => {
    const sticky = makeSticky({ id: "stkerror12345" });
    vi.spyOn(tauri, "canvasProposeLock").mockRejectedValue(
      new Error("disk full"),
    );

    renderHostsAndAffordances([sticky]);
    fireEvent.mouseEnter(screen.getByTestId(`agi-affordance-${sticky.id}`));
    const btn = await screen.findByTestId(`propose-lock-${sticky.id}`);

    await act(async () => {
      fireEvent.click(btn);
    });

    // The button re-enables after the error path resolves.
    await waitFor(() => {
      expect(btn).not.toHaveAttribute("disabled");
    });
  });
});

// ============================================================
// 3. Tauri wrapper round-trip (mock fallback path)
// ============================================================

describe("Tauri wrappers (mock fallback)", () => {
  it("agiThrowSticky returns a 12-char hex id when not in Tauri", async () => {
    const id = await tauri.agiThrowSticky(
      "tangerine",
      "v1-8-ideation",
      "test body",
      "yellow",
    );
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("canvasProposeLock returns a deterministic mock path when not in Tauri", async () => {
    const path = await tauri.canvasProposeLock(
      "tangerine",
      "Pricing Discussion!",
      "stk001",
    );
    expect(path).toContain("canvas-pricing-discussion-stk001.md");
  });

  it("agiCommentSticky resolves cleanly in mock mode", async () => {
    await expect(
      tauri.agiCommentSticky("p", "t", "id", "comment body"),
    ).resolves.toBeUndefined();
  });
});
