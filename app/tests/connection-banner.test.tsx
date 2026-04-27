import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ConnectionBanner } from "../src/components/ConnectionBanner";
import { setupI18n } from "../src/i18n";

/**
 * Wave 3 — ConnectionBanner tests (OBSERVABILITY_SPEC §8 edge case).
 *
 * Drives the `online` / `offline` window events directly to confirm the
 * banner mounts/unmounts on the right state transitions, and that it
 * carries `role="alert"` for screen-reader announcement.
 */
describe("ConnectionBanner", () => {
  beforeEach(() => {
    // i18n must be initialised; idempotent so safe to call repeatedly.
    setupI18n();
    // Force the navigator.onLine getter to a known initial state.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when initially online", () => {
    const { container } = render(<ConnectionBanner />);
    expect(container.querySelector("[data-testid='connection-banner']")).toBeNull();
  });

  it("renders the offline banner with role=alert when offline event fires", () => {
    render(<ConnectionBanner />);
    act(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    const banner = screen.getByTestId("connection-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("data-state", "offline");
  });

  it("flashes a recovery banner on `online` event", () => {
    // Start offline.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    render(<ConnectionBanner />);
    expect(screen.getByTestId("connection-banner")).toHaveAttribute(
      "data-state",
      "offline",
    );
    // Restore.
    act(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event("online"));
    });
    const banner = screen.getByTestId("connection-banner");
    expect(banner).toHaveAttribute("data-state", "online");
  });
});
