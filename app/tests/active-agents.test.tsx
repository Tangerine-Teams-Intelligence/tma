import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { ActiveAgentsSection } from "../src/components/layout/ActiveAgentsSection";
import * as tauri from "../src/lib/tauri";
import type { AgentActivity } from "../src/lib/tauri";

/**
 * v2.0-beta.2 — Tests for the ACTIVE AGENTS sidebar section.
 *
 * The section is a leaf component that polls `getActiveAgents` and renders
 * one row per active personal AI agent. We mock the wrapper directly rather
 * than going through `safeInvoke`, since the wrapper is the contract the
 * component depends on.
 */

const STUB: AgentActivity[] = [
  {
    user: "daizhe",
    agent: "Cursor",
    status: "running",
    last_active: "45min",
    task: "/api/auth refactor",
  },
  {
    user: "daizhe",
    agent: "Devin",
    status: "running",
    last_active: "30min",
    task: "billing flow",
  },
  {
    user: "hongyu",
    agent: "Claude Code",
    status: "idle",
    last_active: "2h",
    task: null,
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActiveAgentsSection", () => {
  it("renders 3 stub agents when getActiveAgents resolves with the v2.0-beta.2 stub", async () => {
    vi.spyOn(tauri, "getActiveAgents").mockResolvedValue(STUB);

    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );

    // List shows up only after the async fetch resolves.
    await waitFor(() => {
      expect(screen.getByTestId("active-agents-list")).toBeInTheDocument();
    });

    // One <li> per stub row.
    expect(
      screen.getByTestId("active-agent-row-daizhe-Cursor"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("active-agent-row-daizhe-Devin"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("active-agent-row-hongyu-Claude Code"),
    ).toBeInTheDocument();

    // Agent kind labels render.
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Devin")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();

    // Last-active timestamps render.
    expect(screen.getByText("45min")).toBeInTheDocument();
    expect(screen.getByText("30min")).toBeInTheDocument();
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("renders empty state when no agents are active", async () => {
    vi.spyOn(tauri, "getActiveAgents").mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-agents-empty")).toBeInTheDocument();
    });

    expect(screen.getByText(/no active agents/i)).toBeInTheDocument();
    // The full list must not render alongside the empty state.
    expect(screen.queryByTestId("active-agents-list")).not.toBeInTheDocument();
  });

  it("renders an error state when the Tauri command rejects", async () => {
    vi.spyOn(tauri, "getActiveAgents").mockRejectedValue(
      new Error("bridge missing"),
    );
    // Suppress the component's console.error logging for this test only.
    vi.spyOn(console, "error").mockImplementation(() => {
      /* swallow */
    });

    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-agents-error")).toBeInTheDocument();
    });
    // The list must not render alongside the error.
    expect(screen.queryByTestId("active-agents-list")).not.toBeInTheDocument();
  });

  it("clicking a row navigates to /people/<user>", async () => {
    vi.spyOn(tauri, "getActiveAgents").mockResolvedValue(STUB);

    render(
      <MemoryRouter initialEntries={["/today"]}>
        <Routes>
          <Route
            path="/today"
            element={<ActiveAgentsSection />}
          />
          <Route
            path="/people/:user"
            element={<div data-testid="person-route">person</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-agents-list")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("active-agent-row-daizhe-Cursor"));

    await waitFor(() => {
      expect(screen.getByTestId("person-route")).toBeInTheDocument();
    });
  });

  it("renders status dots that match each agent's status", async () => {
    vi.spyOn(tauri, "getActiveAgents").mockResolvedValue(STUB);

    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-agents-list")).toBeInTheDocument();
    });

    // Two running rows + one idle row.
    expect(screen.getAllByTestId("status-dot-running")).toHaveLength(2);
    expect(screen.getAllByTestId("status-dot-idle")).toHaveLength(1);
    // No error rows in the canonical stub.
    expect(screen.queryAllByTestId("status-dot-error")).toHaveLength(0);
  });

  it("shows loading state while the first fetch is in flight", () => {
    // Keep the promise pending so we can observe the loading state. We
    // resolve it in the cleanup so the dangling promise doesn't leak.
    let resolvePending: (value: AgentActivity[]) => void = () => {};
    const pending = new Promise<AgentActivity[]>((r) => {
      resolvePending = r;
    });
    vi.spyOn(tauri, "getActiveAgents").mockReturnValue(pending);

    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("active-agents-loading")).toBeInTheDocument();
    // Cleanup — flush the pending promise.
    resolvePending([]);
  });
});
