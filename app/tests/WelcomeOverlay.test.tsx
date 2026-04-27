import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { WelcomeOverlay } from "../src/components/WelcomeOverlay";
import { useStore } from "../src/lib/store";

beforeEach(() => {
  // Reset welcomed flag so each test starts on a fresh-install footing.
  useStore.setState((s) => ({
    ui: { ...s.ui, welcomed: false, lastWelcomedVersion: "" },
  }));
});

describe("WelcomeOverlay", () => {
  it("renders 4 value cards on first run", () => {
    render(<WelcomeOverlay />);
    expect(screen.getByTestId("welcome-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-card-0")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-card-1")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-card-2")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-card-3")).toBeInTheDocument();
  });

  it("shows the four CEO-mandated value props", () => {
    render(<WelcomeOverlay />);
    // Card 1 — no new subscription
    expect(screen.getByText(/no new ai subscription/i)).toBeInTheDocument();
    // Card 2 — markdown brain
    expect(screen.getByText(/markdown doc/i)).toBeInTheDocument();
    // Card 3 — cross-vendor visibility
    expect(screen.getByText(/cross-vendor visibility/i)).toBeInTheDocument();
    // Card 4 — 10 AI tools
    expect(screen.getByText(/10 ai tools aligned/i)).toBeInTheDocument();
  });

  it("does not render when welcomed is already true and on the current version", () => {
    // === wave 6 === BUG #3 — overlay re-shows when the persisted
    // `lastWelcomedVersion` doesn't match the running `__APP_VERSION__`,
    // so we set both flags to mimic "user dismissed on this build".
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        welcomed: true,
        lastWelcomedVersion: __APP_VERSION__,
      },
    }));
    const { container } = render(<WelcomeOverlay />);
    expect(container.querySelector('[data-testid="welcome-overlay"]')).toBeNull();
  });

  // === wave 6 === BUG #3 — version-aware re-show.
  it("re-shows the overlay when welcomed=true but lastWelcomedVersion is older", () => {
    useStore.setState((s) => ({
      ui: {
        ...s.ui,
        welcomed: true,
        lastWelcomedVersion: "0.0.0", // older than __APP_VERSION__
      },
    }));
    render(<WelcomeOverlay />);
    expect(screen.getByTestId("welcome-overlay")).toBeInTheDocument();
  });

  it("'Get started' stamps lastWelcomedVersion to the current build", () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId("welcome-start"));
    expect(useStore.getState().ui.welcomed).toBe(true);
    expect(useStore.getState().ui.lastWelcomedVersion).toBe(__APP_VERSION__);
  });

  it("'Get started' flips welcomed and unmounts the overlay", () => {
    const { rerender } = render(<WelcomeOverlay />);
    expect(useStore.getState().ui.welcomed).toBe(false);
    fireEvent.click(screen.getByTestId("welcome-start"));
    expect(useStore.getState().ui.welcomed).toBe(true);
    rerender(<WelcomeOverlay />);
    expect(screen.queryByTestId("welcome-overlay")).toBeNull();
  });

  it("'Skip tour' link flips welcomed", () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId("welcome-skip"));
    expect(useStore.getState().ui.welcomed).toBe(true);
  });

  it("Esc key dismisses the overlay", () => {
    render(<WelcomeOverlay />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useStore.getState().ui.welcomed).toBe(true);
  });

  it("primary CTA receives focus on mount", async () => {
    vi.useFakeTimers();
    render(<WelcomeOverlay />);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(document.activeElement).toBe(screen.getByTestId("welcome-start"));
    vi.useRealTimers();
  });

  it("includes the 30-second positioning in the headline", () => {
    render(<WelcomeOverlay />);
    expect(
      screen.getByRole("heading", { name: /30 seconds/i }),
    ).toBeInTheDocument();
  });
});
