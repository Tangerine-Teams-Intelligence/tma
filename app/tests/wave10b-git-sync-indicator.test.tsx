// === wave 10-B ===
// Pure-presentational tests for GitSyncIndicator. We mock the `status`
// prop directly — no Tauri harness needed because the component never
// calls IPC itself.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  GitSyncIndicator,
  type GitSyncIndicatorLabels,
  type GitSyncStatus,
} from "../src/components/GitSyncIndicator";

const LABELS: GitSyncIndicatorLabels = {
  notInitialized: "Memory dir not yet git-tracked",
  cleanInSync: "Up to date",
  pushingAhead: (n: number) => `Pushing ${n} commit${n === 1 ? "" : "s"}`,
  pullConflict: "Pull conflict — resolve in /today",
  pulling: "Pulling latest team memory",
  lastPullPrefix: "Last pull: ",
};

function renderWith(status: GitSyncStatus, onClick?: () => void) {
  return render(
    <GitSyncIndicator status={status} onClick={onClick} labels={LABELS} />,
  );
}

describe("GitSyncIndicator", () => {
  it("renders not_initialized state with grey GitBranch", () => {
    renderWith({ state: "not_initialized" });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "not_initialized");
    expect(el).toHaveAttribute("aria-label", LABELS.notInitialized);
    expect(el).toHaveAttribute("title", LABELS.notInitialized);
  });

  it("renders clean state with last_pull tooltip", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    renderWith({ state: "clean", last_pull_iso: iso });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "clean");
    // tooltip = "Up to date Last pull: 5m ago"
    expect(el.getAttribute("aria-label")).toContain(LABELS.cleanInSync);
    expect(el.getAttribute("aria-label")).toContain(LABELS.lastPullPrefix);
    expect(el.getAttribute("aria-label")).toMatch(/5m ago/);
  });

  it("renders clean state without last_pull info gracefully", () => {
    renderWith({ state: "clean" });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "clean");
    expect(el).toHaveAttribute("aria-label", LABELS.cleanInSync);
  });

  it("renders pushing state with ahead count in tooltip", () => {
    renderWith({ state: "pushing", ahead: 3 });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "pushing");
    expect(el).toHaveAttribute("aria-label", "Pushing 3 commits");
    // arrow icon should spin
    const svg = el.querySelector("svg");
    expect(svg?.getAttribute("class")).toMatch(/animate-spin/);
  });

  it("renders pushing state with singular when ahead=1", () => {
    renderWith({ state: "pushing", ahead: 1 });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("aria-label", "Pushing 1 commit");
  });

  it("renders pulling state with spinning down arrow", () => {
    renderWith({ state: "pulling" });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "pulling");
    expect(el).toHaveAttribute("aria-label", LABELS.pulling);
    const svg = el.querySelector("svg");
    expect(svg?.getAttribute("class")).toMatch(/animate-spin/);
  });

  it("renders conflict state with red AlertCircle", () => {
    renderWith({
      state: "conflict",
      conflict_files: ["people/alice.md", "people/bob.md"],
    });
    const el = screen.getByTestId("git-sync-indicator");
    expect(el).toHaveAttribute("data-state", "conflict");
    expect(el).toHaveAttribute("aria-label", LABELS.pullConflict);
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    renderWith({ state: "clean" }, onClick);
    fireEvent.click(screen.getByTestId("git-sync-indicator"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not throw when onClick is omitted", () => {
    renderWith({ state: "clean" });
    expect(() =>
      fireEvent.click(screen.getByTestId("git-sync-indicator")),
    ).not.toThrow();
  });

  it("tooltip text matches the exact label per state", () => {
    const cases: Array<{ status: GitSyncStatus; expected: string }> = [
      { status: { state: "not_initialized" }, expected: LABELS.notInitialized },
      { status: { state: "clean" }, expected: LABELS.cleanInSync },
      { status: { state: "pushing", ahead: 2 }, expected: "Pushing 2 commits" },
      { status: { state: "pulling" }, expected: LABELS.pulling },
      { status: { state: "conflict" }, expected: LABELS.pullConflict },
    ];
    for (const { status, expected } of cases) {
      const { unmount } = renderWith(status);
      const el = screen.getByTestId("git-sync-indicator");
      // For not_initialized / clean (no last_pull) / pulling / conflict the
      // label is the entire tooltip; for clean-with-last-pull we tested
      // separately above.
      expect(el.getAttribute("title")).toContain(expected);
      unmount();
    }
  });
});
