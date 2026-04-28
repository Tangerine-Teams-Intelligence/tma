// === wave 10 ===
// Vitest coverage for the v1.10 git-sync container components + Cmd+K
// palette additions + GitInitBanner trigger logic. We mock `@/lib/tauri`
// so we don't need a real Tauri harness — the container's job is to map
// the Rust shape into the presentational component's props, which we
// assert against.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// All container imports go through @/lib/tauri — we need the mock in place
// BEFORE the SUT module loads, otherwise the real (mock-fallback) wrappers
// are bound to the components.
const tauriMocks = vi.hoisted(() => ({
  gitSyncStatus: vi.fn(),
  gitSyncPull: vi.fn(),
  gitSyncPush: vi.fn(),
  gitSyncHistory: vi.fn(),
  gitSyncInit: vi.fn(),
  showInFolder: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    gitSyncStatus: tauriMocks.gitSyncStatus,
    gitSyncPull: tauriMocks.gitSyncPull,
    gitSyncPush: tauriMocks.gitSyncPush,
    gitSyncHistory: tauriMocks.gitSyncHistory,
    gitSyncInit: tauriMocks.gitSyncInit,
    showInFolder: tauriMocks.showInFolder,
  };
});

// Reset the mocks before every test so call counters don't leak.
beforeEach(() => {
  tauriMocks.gitSyncStatus.mockReset();
  tauriMocks.gitSyncPull.mockReset();
  tauriMocks.gitSyncPush.mockReset();
  tauriMocks.gitSyncHistory.mockReset();
  tauriMocks.gitSyncInit.mockReset();
  tauriMocks.showInFolder.mockReset();
});

import { GitSyncIndicatorContainer } from "../src/components/GitSyncIndicatorContainer";
import { GitInitBannerContainer } from "../src/components/GitInitBannerContainer";

const baseStatus = {
  state: "clean" as const,
  memory_dir: "/home/test/.tangerine-memory",
  git_available: true,
  git_initialized: true,
  has_remote: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  last_commit_msg: "co-thinker heartbeat 2026-04-27 — 3 atoms, 1 vendors",
  last_commit_ts: new Date(Date.now() - 60 * 1000).toISOString(),
  last_auto_pull: new Date(Date.now() - 90 * 1000).toISOString(),
  last_auto_push: null,
  last_error: null,
};

describe("GitSyncIndicatorContainer", () => {
  it("renders the clean state with the green dot", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue(baseStatus);
    render(<GitSyncIndicatorContainer />);
    const btn = await screen.findByTestId("git-sync-indicator");
    expect(btn).toHaveAttribute("data-state", "clean");
  });

  it("opens the popover and lists branch / ahead / behind", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({ ...baseStatus, ahead: 3 });
    tauriMocks.gitSyncHistory.mockResolvedValue([
      {
        sha: "abcdef1234567",
        message: "co-thinker heartbeat 2026-04-27 — 3 atoms",
        ts: new Date().toISOString(),
        author: "tangerine-test",
      },
    ]);
    render(<GitSyncIndicatorContainer />);
    const btn = await screen.findByTestId("git-sync-indicator");
    fireEvent.click(btn);
    const popover = await screen.findByTestId("git-sync-popover");
    expect(popover).toBeInTheDocument();
    // Branch + ahead value visible in popover.
    expect(popover).toHaveTextContent("main");
    expect(popover).toHaveTextContent("3");
    // History list rendered after the lazy fetch resolves.
    await screen.findByTestId("git-sync-popover-history");
  });

  it("invokes onClickInit when the indicator is in the not-init state", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "not_initialized",
      git_initialized: false,
      branch: null,
      last_commit_msg: null,
      last_commit_ts: null,
      last_auto_pull: null,
    });
    const onClickInit = vi.fn();
    render(<GitSyncIndicatorContainer onClickInit={onClickInit} />);
    const btn = await screen.findByTestId("git-sync-indicator");
    expect(btn).toHaveAttribute("data-state", "not_initialized");
    fireEvent.click(btn);
    expect(onClickInit).toHaveBeenCalledTimes(1);
  });

  it("calls Pull when the popover Pull-now button is clicked", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue(baseStatus);
    tauriMocks.gitSyncPull.mockResolvedValue({
      ok: true,
      conflict: false,
      message: "pulled",
    });
    tauriMocks.gitSyncHistory.mockResolvedValue([]);
    render(<GitSyncIndicatorContainer />);
    fireEvent.click(await screen.findByTestId("git-sync-indicator"));
    const pullBtn = await screen.findByTestId("git-sync-popover-pull");
    await act(async () => {
      fireEvent.click(pullBtn);
    });
    expect(tauriMocks.gitSyncPull).toHaveBeenCalledTimes(1);
  });

  it("renders the conflict-state error block in the popover", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "conflict",
      last_error: "pull_conflict: CONFLICT (content): Merge conflict in atoms.md",
    });
    tauriMocks.gitSyncHistory.mockResolvedValue([]);
    render(<GitSyncIndicatorContainer />);
    const btn = await screen.findByTestId("git-sync-indicator");
    expect(btn).toHaveAttribute("data-state", "conflict");
    fireEvent.click(btn);
    expect(
      await screen.findByTestId("git-sync-popover-error"),
    ).toHaveTextContent(/CONFLICT/);
  });
});

describe("GitInitBannerContainer", () => {
  // The container relies on the persisted `gitMode` value. The store is
  // module-level singleton so we have to reset it at the start of each
  // test to avoid leaking state between cases.
  beforeEach(async () => {
    const { useStore } = await import("../src/lib/store");
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        gitMode: "unknown",
        currentUser: "test-user",
      },
    }));
  });

  it("hides the banner when memory dir is already git-tracked", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      git_initialized: true,
    });
    render(<GitInitBannerContainer />);
    // Wait a tick for the effect to run.
    await waitFor(() => {
      expect(tauriMocks.gitSyncStatus).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("git-init-banner")).not.toBeInTheDocument();
  });

  it("shows the banner when memory dir exists but is not yet git-tracked", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "not_initialized",
      git_initialized: false,
      branch: null,
      last_commit_msg: null,
      last_commit_ts: null,
    });
    render(<GitInitBannerContainer />);
    await screen.findByTestId("git-init-banner");
  });

  it("calls gitSyncInit and flips gitMode=init when Initialize-now succeeds", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "not_initialized",
      git_initialized: false,
    });
    tauriMocks.gitSyncInit.mockResolvedValue({
      ...baseStatus,
      state: "clean",
      git_initialized: true,
    });
    const { useStore } = await import("../src/lib/store");
    render(<GitInitBannerContainer />);
    await screen.findByTestId("git-init-banner");
    // First click expands the URL input, second click runs init.
    fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    await screen.findByTestId("git-init-banner-remote-url");
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-init-banner-initialize"));
    });
    expect(tauriMocks.gitSyncInit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().ui.gitMode).toBe("init");
  });

  it("flips gitMode=skip on the Already-on-Cloud confirm path", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "not_initialized",
      git_initialized: false,
    });
    const { useStore } = await import("../src/lib/store");
    render(<GitInitBannerContainer />);
    await screen.findByTestId("git-init-banner");
    fireEvent.click(screen.getByTestId("git-init-banner-already-on-cloud"));
    await screen.findByTestId("git-init-banner-confirm-skip");
    fireEvent.click(screen.getByTestId("git-init-banner-already-on-cloud"));
    expect(useStore.getState().ui.gitMode).toBe("skip");
  });

  it("flips gitMode=later on Maybe-later (per-session dismiss)", async () => {
    tauriMocks.gitSyncStatus.mockResolvedValue({
      ...baseStatus,
      state: "not_initialized",
      git_initialized: false,
    });
    const { useStore } = await import("../src/lib/store");
    render(<GitInitBannerContainer />);
    await screen.findByTestId("git-init-banner");
    fireEvent.click(screen.getByTestId("git-init-banner-maybe-later"));
    expect(useStore.getState().ui.gitMode).toBe("later");
  });
});

describe("Cmd+K palette items", () => {
  it("includes the four wave-10 git palette commands", async () => {
    // The CommandPalette catalog is hand-rolled inside the component; we
    // smoke-test by mounting it open and asserting each label appears at
    // least once when the user types its prefix.
    const { CommandPalette } = await import(
      "../src/components/CommandPalette"
    );
    const { MemoryRouter } = await import("react-router-dom");
    tauriMocks.gitSyncStatus.mockResolvedValue(baseStatus);
    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("command-palette-item-action:git-pull-team"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("command-palette-item-action:git-push-team"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("command-palette-item-action:git-history"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("command-palette-item-action:git-init"),
    ).toBeInTheDocument();
  });
});
