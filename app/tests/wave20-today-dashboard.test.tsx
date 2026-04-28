// === wave 20 ===
/**
 * Wave 20 — /today dashboard rewrite tests.
 *
 * /today is now the home dashboard with:
 *   • Stat strip (date · atoms · watched · tools)
 *   • Hero search (Wave 14 chat input + Send)
 *   • 4 widget cards stacked vertically:
 *       1. Recent decisions
 *       2. Today's activity
 *       3. Team brain status
 *       4. Connected tools
 *
 * Setup mode (`setupWizardChannelReady === false`) hides the entire
 * dashboard and renders OnboardingChat instead.
 *
 * We hoist mocks for the four data sources so each widget hydrates
 * deterministically and we can assert on the rendered rows.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Hoisted mocks for `@/lib/tauri` — the dashboard pulls 4 concurrent
// fetches off the Tauri bridge; each test sets them up before mounting.
const tauriMocks = vi.hoisted(() => {
  return {
    activityRecent: vi.fn(),
    listenActivityAtoms: vi.fn(async () => () => {}),
    coThinkerReadBrain: vi.fn(),
    coThinkerStatus: vi.fn(),
    coThinkerDispatch: vi.fn(),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    activityRecent: tauriMocks.activityRecent,
    listenActivityAtoms: tauriMocks.listenActivityAtoms,
    coThinkerReadBrain: tauriMocks.coThinkerReadBrain,
    coThinkerStatus: tauriMocks.coThinkerStatus,
    coThinkerDispatch: tauriMocks.coThinkerDispatch,
  };
});

import TodayRoute from "../src/routes/today";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  vi.restoreAllMocks();
  tauriMocks.activityRecent.mockReset();
  tauriMocks.listenActivityAtoms.mockClear();
  tauriMocks.coThinkerReadBrain.mockReset();
  tauriMocks.coThinkerStatus.mockReset();
  tauriMocks.coThinkerDispatch.mockReset();

  // Default mock returns — widgets render their empty / idle states.
  tauriMocks.activityRecent.mockResolvedValue([]);
  tauriMocks.listenActivityAtoms.mockImplementation(async () => () => {});
  tauriMocks.coThinkerReadBrain.mockResolvedValue("");
  tauriMocks.coThinkerStatus.mockResolvedValue({
    last_heartbeat_at: null,
    next_heartbeat_at: null,
    brain_doc_size: 0,
    observations_today: 0,
  });

  // Default into post-setup so the dashboard mounts. Individual tests
  // can flip this when they need the OnboardingChat surface.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      setupWizardChannelReady: true,
      onboardingMode: "chat",
    },
  }));
});

afterEach(() => {
  cleanup();
});

function renderToday() {
  return render(
    <MemoryRouter>
      <TodayRoute />
    </MemoryRouter>,
  );
}

describe("Wave 20 — /today dashboard", () => {
  it("renders the stat strip with date + counts derived from activity + tools", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "team/co-thinker.md",
        title: "Brain refresh",
        vendor: null,
        author: "alex",
        timestamp: new Date().toISOString(),
        kind: "brain_update",
      },
      {
        path: "personal/sam/threads/cursor/abc.md",
        title: "Pricing thread",
        vendor: "cursor",
        author: "sam",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
    ]);

    renderToday();

    const strip = await screen.findByTestId("today-stat-strip");
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId("today-stat-date").textContent).toMatch(
      /^Today, /,
    );
    // Two activity events fan out to atoms count + 2 unique authors.
    await waitFor(() => {
      expect(screen.getByTestId("today-stat-atoms").textContent).toMatch(
        /2 atoms/,
      );
      expect(screen.getByTestId("today-stat-watched").textContent).toMatch(
        /2 watched/,
      );
    });
    // Tools active = installed count from MOCK_TOOLS (cursor only).
    expect(screen.getByTestId("today-stat-tools").textContent).toMatch(
      /1 tools active/,
    );
  });

  it("hero search submits via coThinkerDispatch and renders the response", async () => {
    tauriMocks.coThinkerDispatch.mockResolvedValue({
      text: "Sam shipped the **flat-rate** decision on Apr 22.",
      channel_used: "mcp_sampling",
      tool_id: "cursor",
      latency_ms: 211,
      tokens_estimate: 18,
    });

    renderToday();

    const textarea = await screen.findByTestId("today-chat-textarea");
    fireEvent.change(textarea, {
      target: { value: "What did we decide on pricing?" },
    });
    fireEvent.click(screen.getByTestId("today-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("today-chat-response")).toBeInTheDocument();
    });
    expect(screen.getByTestId("today-chat-response")).toHaveTextContent(
      /flat-rate/i,
    );
    expect(tauriMocks.coThinkerDispatch).toHaveBeenCalledTimes(1);
  });

  it("Recent decisions widget renders rows when the activity buffer has decisions", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "team/decisions/pcb-tier2.md",
        title: "PCB Tier 2 supplier",
        vendor: "cursor",
        author: "alex",
        timestamp: "2026-04-22T10:00:00Z",
        kind: "decision",
      },
      {
        path: "personal/me/threads/claude-code/x.md",
        title: "Random thread",
        vendor: "claude-code",
        author: "me",
        timestamp: "2026-04-26T11:00:00Z",
        kind: "thread",
      },
      {
        path: "team/decisions/pricing.md",
        title: "Pricing shift to $80/team",
        vendor: "cursor",
        author: "sam",
        timestamp: "2026-04-26T12:00:00Z",
        kind: "decision",
      },
    ]);

    renderToday();

    await waitFor(() => {
      const rows = screen.getAllByTestId("dashboard-decision-row");
      expect(rows.length).toBe(2);
    });
    // Scope the title check to the decisions widget — the activity widget
    // is also fed from the same buffer and would otherwise match too.
    const decisionsCard = screen.getByTestId("dashboard-recent-decisions");
    expect(decisionsCard).toHaveTextContent(/PCB Tier 2 supplier/);
    expect(decisionsCard).toHaveTextContent(/Pricing shift to/);
    // The "Random thread" (kind=thread) must not appear in this widget.
    expect(decisionsCard.textContent).not.toMatch(/Random thread/);
    // [More] action points to /this-week.
    const action = screen.getByTestId("dashboard-recent-decisions-action");
    expect(action.getAttribute("href")).toBe("/this-week");
  });

  it("Today's activity widget renders rows from activityRecent", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "personal/sam/threads/claude-code/foo.md",
        title: "Pushed Claude Code session",
        vendor: "claude-code",
        author: "sam",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
      {
        path: "personal/alex/threads/cursor/bar.md",
        title: "Asked Cursor about API",
        vendor: "cursor",
        author: "alex",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
    ]);

    renderToday();

    await waitFor(() => {
      const rows = screen.getAllByTestId("dashboard-activity-row");
      expect(rows.length).toBe(2);
    });
    const activityCard = screen.getByTestId("dashboard-todays-activity");
    expect(activityCard).toHaveTextContent(/Pushed Claude Code session/);
    expect(activityCard).toHaveTextContent(/Asked Cursor about API/);
    // listenActivityAtoms must be subscribed (live updates).
    await waitFor(() => {
      expect(tauriMocks.listenActivityAtoms).toHaveBeenCalled();
    });
  });

  it("Team brain status widget renders sync time + preview + Open link", async () => {
    tauriMocks.coThinkerReadBrain.mockResolvedValue(
      "---\ntitle: brain\n---\nWe're tracking PCB supplier evaluation, flag rollout strategy, and pricing shifts across April.",
    );
    tauriMocks.coThinkerStatus.mockResolvedValue({
      last_heartbeat_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      next_heartbeat_at: null,
      brain_doc_size: 1234,
      observations_today: 5,
    });

    renderToday();

    await waitFor(() => {
      expect(
        screen.getByTestId("dashboard-brain-status-sync"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("dashboard-brain-status-sync").textContent,
    ).toMatch(/Last sync:.*ago/);
    expect(
      screen.getByTestId("dashboard-brain-status-preview").textContent,
    ).toMatch(/PCB supplier evaluation/);
    // Open link points to /brain (Wave 19 alias).
    const open = screen.getByTestId("dashboard-brain-status-action");
    expect(open.getAttribute("href")).toBe("/brain");
  });

  it("Connected tools widget renders one row per installed tool with atom counts", async () => {
    tauriMocks.activityRecent.mockResolvedValue([
      {
        path: "personal/me/threads/cursor/a.md",
        title: "thread a",
        vendor: "cursor",
        author: "me",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
      {
        path: "personal/me/threads/cursor/b.md",
        title: "thread b",
        vendor: "cursor",
        author: "me",
        timestamp: new Date().toISOString(),
        kind: "thread",
      },
    ]);

    renderToday();

    await waitFor(() => {
      const rows = screen.getAllByTestId("dashboard-tool-row");
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
    // Cursor row should appear and report 2 atoms today.
    const cursorRow = screen
      .getAllByTestId("dashboard-tool-row")
      .find((r) => r.getAttribute("data-tool-id") === "cursor");
    expect(cursorRow).toBeTruthy();
    expect(cursorRow!.textContent).toMatch(/2 atoms today/);
    // Manage link points to /settings.
    const manage = screen.getByTestId("dashboard-connected-tools-action");
    expect(manage.getAttribute("href")).toBe("/settings");
  });

  it("setup mode hides every widget and renders OnboardingChat instead", async () => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        setupWizardChannelReady: false,
        onboardingMode: "chat",
      },
    }));

    renderToday();

    // Setup-mode shell is the only thing rendered in the content area.
    expect(await screen.findByTestId("today-setup")).toBeInTheDocument();
    // None of the dashboard widgets should mount.
    expect(screen.queryByTestId("today-stat-strip")).toBeNull();
    expect(screen.queryByTestId("today-widget-stack")).toBeNull();
    expect(screen.queryByTestId("dashboard-recent-decisions")).toBeNull();
    expect(screen.queryByTestId("dashboard-todays-activity")).toBeNull();
    expect(screen.queryByTestId("dashboard-brain-status")).toBeNull();
    expect(screen.queryByTestId("dashboard-connected-tools")).toBeNull();
    // Smoke-test contract: literal "Today" still reachable.
    expect(screen.getByText(/^Today$/i)).toBeInTheDocument();
  });

  it("widgets gracefully degrade to empty states when data sources are empty", async () => {
    // All mocks already default to [] / "" / null in beforeEach.
    renderToday();

    // Each widget shows its inline empty caption.
    expect(
      await screen.findByTestId("dashboard-recent-decisions-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-todays-activity-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-brain-status-empty"),
    ).toBeInTheDocument();
    // Connected tools shows the MOCK_TOOLS fixture (cursor installed)
    // even when activity is empty — the empty state is reserved for
    // the real "zero installed tools" case.
    expect(screen.queryByTestId("dashboard-connected-tools-empty")).toBeNull();
    const cursorRow = screen
      .getAllByTestId("dashboard-tool-row")
      .find((r) => r.getAttribute("data-tool-id") === "cursor");
    expect(cursorRow).toBeTruthy();
    expect(cursorRow!.textContent).toMatch(/0 atoms today/);
  });

  it("widget data fetch error renders inline without crashing the dashboard", async () => {
    // Force the brain widget's Promise.all to reject by failing
    // coThinkerReadBrain — DashboardWidget renders the inline error
    // shell; the other 3 widgets continue to mount.
    tauriMocks.coThinkerReadBrain.mockRejectedValue(
      new Error("brain_doc_unreadable"),
    );

    renderToday();

    await waitFor(() => {
      expect(
        screen.getByTestId("dashboard-brain-status-error"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("dashboard-brain-status-error").textContent,
    ).toMatch(/brain_doc_unreadable/);
    // Other widgets still rendered.
    expect(
      screen.getByTestId("dashboard-recent-decisions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-todays-activity"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-connected-tools")).toBeInTheDocument();
  });
});
// === end wave 20 ===
