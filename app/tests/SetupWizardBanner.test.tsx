// === wave 11 ===
/**
 * v1.10.2 — SetupWizardBanner tests.
 *
 * Coverage:
 *   - hides when channel_ready true
 *   - hides when dismissed_this_session true
 *   - shows when both flags false
 *   - "Set up now" button flips setupWizardOpen
 *   - "Dismiss" button flips dismissedThisSession
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SetupWizardBanner } from "../src/components/SetupWizardBanner";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      setupWizardChannelReady: false,
      setupWizardDismissedThisSession: false,
      setupWizardOpen: false,
    },
  }));
});

describe("SetupWizardBanner", () => {
  it("renders when channel not ready and not dismissed", () => {
    render(<SetupWizardBanner />);
    expect(screen.getByTestId("setup-wizard-banner")).toBeInTheDocument();
  });

  it("hides when channel_ready is true", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, setupWizardChannelReady: true },
    }));
    const { container } = render(<SetupWizardBanner />);
    expect(container.querySelector('[data-testid="setup-wizard-banner"]')).toBeNull();
  });

  it("hides when dismissed_this_session is true", () => {
    useStore.setState((s) => ({
      ui: { ...s.ui, setupWizardDismissedThisSession: true },
    }));
    const { container } = render(<SetupWizardBanner />);
    expect(container.querySelector('[data-testid="setup-wizard-banner"]')).toBeNull();
  });

  it("'Set up now' opens the wizard via store", () => {
    render(<SetupWizardBanner />);
    fireEvent.click(screen.getByTestId("setup-wizard-banner-open"));
    expect(useStore.getState().ui.setupWizardOpen).toBe(true);
  });

  it("'Dismiss' flips dismissedThisSession", () => {
    render(<SetupWizardBanner />);
    fireEvent.click(screen.getByTestId("setup-wizard-banner-dismiss"));
    expect(useStore.getState().ui.setupWizardDismissedThisSession).toBe(true);
  });
});
// === end wave 11 ===
