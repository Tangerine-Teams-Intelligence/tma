// === v1.14.6 round-7 ===
/**
 * v1.14 R7 — In-app version changelog route + lastSeenAppVersion store.
 *
 * Pins the discoverability fix:
 *
 *   1. /whats-new-app renders the v1.14.6 entry (and prior major
 *      versions) — proves the bundled markdown is wired correctly so
 *      the "what shipped" signal is actually visible inside the app.
 *   2. Visiting the route stamps `lastSeenAppVersion` forward — so the
 *      AppShell upgrade-toast effect won't re-fire on next launch.
 *   3. The store setter handles the null → version transition cleanly
 *      (first visit ever).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

import { useStore } from "../src/lib/store";
import WhatsNewAppRoute, { APP_VERSION } from "../src/routes/whats-new-app";

beforeEach(() => {
  useStore.setState((s) => ({
    ui: { ...s.ui, lastSeenAppVersion: null },
  }));
});

afterEach(() => {
  cleanup();
});

describe("v1.14 R7 — /whats-new-app", () => {
  it("renders the v1.14.6 release block", () => {
    render(
      <MemoryRouter initialEntries={["/whats-new-app"]}>
        <WhatsNewAppRoute />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("whats-new-app")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /what's new/i })).toBeInTheDocument();
    expect(screen.getByText(/v1\.14\.6/i)).toBeInTheDocument();
    // Round 7's two anchor user-visible entries.
    expect(screen.getByText(/Burst debounce/i)).toBeInTheDocument();
    expect(screen.getByText(/version changelog/i)).toBeInTheDocument();
  });

  it("stamps lastSeenAppVersion forward on visit", () => {
    expect(useStore.getState().ui.lastSeenAppVersion).toBeNull();
    render(
      <MemoryRouter initialEntries={["/whats-new-app"]}>
        <WhatsNewAppRoute />
      </MemoryRouter>,
    );
    // Effect runs synchronously after mount.
    expect(useStore.getState().ui.lastSeenAppVersion).toBe(APP_VERSION);
  });

  it("APP_VERSION tracks the build-time __APP_VERSION__ constant", () => {
    // v1.15.2 fix #4: APP_VERSION is no longer hardcoded — it's now
    // sourced from `__APP_VERSION__` (injected by vite.config.ts from
    // package.json) so the upgrade-toast comparison in AppShell can
    // never fall out of sync with the shipped bundle.
    expect(APP_VERSION).toBe(__APP_VERSION__);
    // Sanity: the bundled version is a non-empty semver-shaped string.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
// === end v1.14.6 round-7 ===
