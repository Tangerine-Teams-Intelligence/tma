// === wave 13 ===
/**
 * Wave 13 — DemoModeBanner tests.
 *
 * Coverage:
 *   1. Renders only when `ui.demoMode === true`.
 *   2. "Hide" button flips `demoMode = false` (banner unmounts on next render).
 *   3. "Connect your real team" opens the SetupWizard.
 *
 * The banner is store-driven; we mutate `useStore.setState` directly to
 * simulate the AppShell first-launch effect having already flipped
 * `demoMode` true. No Tauri calls are exercised — those are covered by
 * the underlying `commands::demo_seed` Rust unit tests.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { DemoModeBanner } from "../src/components/DemoModeBanner";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  // Reset wave-13 store slice on every test so cross-test contamination
  // can't mask bugs.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      demoMode: false,
      demoSeedAttempted: false,
      setupWizardOpen: false,
    },
  }));
  vi.clearAllMocks();
});

describe("DemoModeBanner", () => {
  it("renders nothing when demoMode is false", () => {
    const { container } = render(<DemoModeBanner />);
    expect(
      container.querySelector("[data-testid='demo-mode-banner']"),
    ).toBeNull();
  });

  it("renders the banner with both CTAs when demoMode is true", () => {
    useStore.setState((s) => ({ ui: { ...s.ui, demoMode: true } }));
    render(<DemoModeBanner />);
    const banner = screen.getByTestId("demo-mode-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("data-state", "visible");
    expect(screen.getByTestId("demo-mode-banner-connect")).toBeInTheDocument();
    expect(screen.getByTestId("demo-mode-banner-hide")).toBeInTheDocument();
  });

  it("Hide button flips demoMode to false", () => {
    useStore.setState((s) => ({ ui: { ...s.ui, demoMode: true } }));
    render(<DemoModeBanner />);
    expect(useStore.getState().ui.demoMode).toBe(true);
    fireEvent.click(screen.getByTestId("demo-mode-banner-hide"));
    expect(useStore.getState().ui.demoMode).toBe(false);
  });

  it("Connect button opens the SetupWizard via store", () => {
    useStore.setState((s) => ({ ui: { ...s.ui, demoMode: true } }));
    render(<DemoModeBanner />);
    expect(useStore.getState().ui.setupWizardOpen).toBe(false);
    fireEvent.click(screen.getByTestId("demo-mode-banner-connect"));
    expect(useStore.getState().ui.setupWizardOpen).toBe(true);
    // The banner should still be rendered — connecting doesn't auto-hide
    // the banner (the user needs to actually finish the wizard / replace
    // the sample data first).
    expect(screen.getByTestId("demo-mode-banner")).toBeInTheDocument();
  });
});
// === end wave 13 ===
