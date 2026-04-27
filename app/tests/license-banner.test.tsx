import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  LicenseTransitionBanner,
  LICENSE_BANNER_DISMISS_KEY,
} from "../src/components/LicenseTransitionBanner";

/**
 * v1.9.0 P4-B — Tests for the license-flip transition banner.
 *
 * These tests force `import.meta.env.MODE = "test"` (vitest default) so
 * the prod-style dismiss flow is what's exercised. The dev-mode "always
 * visible" branch is covered implicitly: in the absence of a localStorage
 * dismiss flag the banner renders, which is also dev-mode behaviour.
 */
beforeEach(() => {
  // Reset between tests so dismissals from one test don't leak into another.
  try {
    window.localStorage.removeItem(LICENSE_BANNER_DISMISS_KEY);
  } catch {
    // jsdom guarantees localStorage; defensive only
  }
  vi.restoreAllMocks();
});

describe("LicenseTransitionBanner", () => {
  it("renders by default when localStorage flag is unset", () => {
    render(<LicenseTransitionBanner />);
    expect(screen.getByTestId("license-transition-banner")).toBeInTheDocument();
    expect(screen.getByText(/License transition/i)).toBeInTheDocument();
    expect(screen.getByText(/AGPL v3/)).toBeInTheDocument();
  });

  it("links to the LICENSE on GitHub", () => {
    render(<LicenseTransitionBanner />);
    const link = screen.getByRole("link", { name: /LICENSE/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/Tangerine-Intelligence/tangerine-meeting-live/blob/main/LICENSE",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("dismiss button sets the localStorage flag", () => {
    render(<LicenseTransitionBanner />);
    const btn = screen.getByTestId("license-transition-banner-dismiss");
    fireEvent.click(btn);
    expect(window.localStorage.getItem(LICENSE_BANNER_DISMISS_KEY)).toBe("true");
  });

  it("hides itself after dismiss in non-dev mode", () => {
    // Vitest runs with MODE=test (not "development") by default — so the
    // dismiss path here mirrors prod behaviour.
    const { container } = render(<LicenseTransitionBanner />);
    fireEvent.click(screen.getByTestId("license-transition-banner-dismiss"));
    expect(container.querySelector("[data-testid='license-transition-banner']"))
      .toBeNull();
  });

  it("stays hidden on remount when flag is already 'true'", () => {
    window.localStorage.setItem(LICENSE_BANNER_DISMISS_KEY, "true");
    const { container } = render(<LicenseTransitionBanner />);
    expect(container.querySelector("[data-testid='license-transition-banner']"))
      .toBeNull();
  });

  it("does not crash when localStorage throws on read", () => {
    const orig = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    try {
      render(<LicenseTransitionBanner />);
      // Banner falls through to "visible" when localStorage is unreadable.
      expect(screen.getByTestId("license-transition-banner")).toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
