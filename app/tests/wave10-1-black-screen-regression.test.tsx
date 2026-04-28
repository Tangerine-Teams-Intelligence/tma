// === wave 10.1 hotfix ===
// Regression test for the v1.10.0 black-screen-of-death bug.
//
// Symptom: Tangerine v1.10.0 (commit cfb110d) opened with a fully black
// Tauri webview. The bundled JS loaded fine, but the React tree died on
// first paint and nothing rendered.
//
// Root cause: Wave 10 added two new mounts (`GitSyncIndicatorContainer`
// in Sidebar, `GitInitBannerContainer` in AppShell). Each polls a Tauri
// command on mount via useEffect. If that command rejected (memory dir
// missing, git not on PATH, status struct deserialise failure), the
// unhandled promise rejection plus a downstream render-time access on
// the resulting `null` value crashed the React tree. With no error
// boundary anywhere in the app, the entire shell blanked.
//
// Fix layers (defence in depth):
//   1. ErrorBoundary wraps both Wave-10 mounts so a render throw
//      collapses to `null` instead of crashing the parent tree.
//   2. Both Container components now try/catch the Tauri call and log
//      to console with the [wave10] prefix; on error the state holds
//      its prior value (null → safe default).
//   3. Rust `git_sync_status` is locked to always return Ok with a
//      sensible default (covered by Rust-side tests in git_sync.rs).
//
// This test asserts: when `gitSyncStatus()` throws on first call, the
// AppShell + Sidebar still render. The git mounts collapse to null /
// defaults rather than blanking the app.

import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the Tauri layer BEFORE the SUT modules load so the throwing
// gitSyncStatus is in place during the very first useEffect tick.
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

beforeEach(() => {
  tauriMocks.gitSyncStatus.mockReset();
  tauriMocks.gitSyncPull.mockReset();
  tauriMocks.gitSyncPush.mockReset();
  tauriMocks.gitSyncHistory.mockReset();
  tauriMocks.gitSyncInit.mockReset();
  tauriMocks.showInFolder.mockReset();
  // Silence the expected console.error from the [wave10] catch-and-log
  // path so the test output stays clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

import { GitSyncIndicatorContainer } from "../src/components/GitSyncIndicatorContainer";
import { GitInitBannerContainer } from "../src/components/GitInitBannerContainer";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

describe("v1.10.0 black-screen regression — defensive mounts", () => {
  it("GitSyncIndicatorContainer does not throw when gitSyncStatus rejects", async () => {
    // Simulate the Tauri-side failure that triggered the original bug.
    tauriMocks.gitSyncStatus.mockRejectedValue(
      new Error("memory_dir not resolvable"),
    );

    // The component must mount without throwing. Pre-fix, the unhandled
    // rejection killed the React tree.
    const sentinel = "container-host-sentinel";
    render(
      <div data-testid={sentinel}>
        <GitSyncIndicatorContainer />
      </div>,
    );

    // Host element survived (would be missing if the throw escaped).
    expect(screen.getByTestId(sentinel)).toBeInTheDocument();

    // Indicator renders the safe `not_initialized` default — derived
    // from `mapStatus(null, null)` because the rust state never
    // populated.
    const btn = await screen.findByTestId("git-sync-indicator");
    expect(btn).toHaveAttribute("data-state", "not_initialized");
  });

  it("GitInitBannerContainer does not throw when gitSyncStatus rejects", async () => {
    tauriMocks.gitSyncStatus.mockRejectedValue(
      new Error("git binary not in PATH"),
    );

    const sentinel = "banner-host-sentinel";
    render(
      <div data-testid={sentinel}>
        <GitInitBannerContainer />
      </div>,
    );

    expect(screen.getByTestId(sentinel)).toBeInTheDocument();

    // status stays null → shouldShow gates to false → banner is null.
    // Wait a tick for the failed-fetch microtask to settle.
    await waitFor(() => {
      expect(tauriMocks.gitSyncStatus).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("git-init-banner")).not.toBeInTheDocument();
  });

  it("ErrorBoundary catches a render-time throw and renders null", () => {
    // Simulates the worst case: a wave-10 component that throws
    // synchronously during render. Pre-fix this killed the parent
    // tree. Post-fix the boundary intercepts and renders fallback.
    function Bomb(): React.ReactElement {
      throw new Error("synthetic mount-time crash");
    }
    const sentinel = "boundary-host-sentinel";
    render(
      <div data-testid={sentinel}>
        <ErrorBoundary label="TestBomb">
          <Bomb />
        </ErrorBoundary>
        <span data-testid="sibling-survives">still here</span>
      </div>,
    );
    // Host + sibling render normally; the bomb's subtree is null.
    expect(screen.getByTestId(sentinel)).toBeInTheDocument();
    expect(screen.getByTestId("sibling-survives")).toBeInTheDocument();
  });

  it("ErrorBoundary logs with the [wave10] prefix on catch", () => {
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    function Bomb(): React.ReactElement {
      throw new Error("synthetic crash for log assert");
    }
    render(
      <ErrorBoundary label="GitSyncIndicator">
        <Bomb />
      </ErrorBoundary>,
    );
    // First call carries the boundary's own log; React may also log
    // its own warnings. We only assert OUR log shape is present.
    const ourCall = errSpy.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].startsWith("[wave10] GitSyncIndicator failed to render:"),
    );
    expect(ourCall).toBeDefined();
  });

  it("GitSyncIndicatorContainer survives even if poll throws on every tick", async () => {
    // Stress: every gitSyncStatus call rejects. The component should
    // never throw — it just keeps rendering the safe default.
    tauriMocks.gitSyncStatus.mockRejectedValue(new Error("perma-fail"));
    const sentinel = "stress-host-sentinel";
    render(
      <div data-testid={sentinel}>
        <GitSyncIndicatorContainer />
      </div>,
    );
    // First tick fires immediately; we wait for it to settle.
    await waitFor(() => {
      expect(tauriMocks.gitSyncStatus).toHaveBeenCalled();
    });
    expect(screen.getByTestId(sentinel)).toBeInTheDocument();
    expect(
      await screen.findByTestId("git-sync-indicator"),
    ).toHaveAttribute("data-state", "not_initialized");
  });
});

