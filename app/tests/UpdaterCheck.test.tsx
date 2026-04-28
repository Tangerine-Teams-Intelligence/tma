// === wave 25 ===
//
// Vitest coverage for the auto-updater banner.
//
// Two cases anchor the surface:
//
//   1. When the updater bridge resolves to a real `update` object (a new
//      version is available), the banner renders with version copy + an
//      "Install now" button.
//   2. When the bridge throws (no Tauri host, signature mismatch, network
//      drop), the banner stays hidden — the swallow path must never blank
//      the shell or render a broken UI.
//
// Vite resolves the dynamic import via a runtime variable + `@vite-ignore`,
// so we cannot intercept with `vi.mock(...)` at module level. Instead we
// monkeypatch the call by stashing the stub on the global object and the
// component's runtime import resolves through Node's module loader. For
// the jsdom environment we don't have the real `@tauri-apps/plugin-updater`
// package installed, so the dynamic `import()` will reject — which is
// exactly the swallow path we want to test for the "no update bridge"
// case. For the positive case we install a vitest dynamic-import alias.
//
// === end wave 25 ===

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { UpdaterCheck } from "../src/components/UpdaterCheck";
import { useStore } from "../src/lib/store";

// Helper: install a fake module at the resolved path for a single test
// run. We mutate `import.meta.glob`-style by hooking vitest's own
// dynamic-import transformer through the `__mocks__` property the
// component's lazy-loader looks for. Simpler: we wrap the test runner's
// module loader by injecting onto `globalThis.__updaterMock__` and
// reading it inside a jest-style transformer. For now, simplest path:
// we stub `console.warn` to detect the swallow path and accept that the
// "real update available" case is exercised by the e2e Playwright suite
// rather than vitest. That gives us the two cases the scope requires:
// graceful-degrade UI (never renders) + happy-path render.
//
// To exercise the happy-path render in vitest we expose a synthetic
// override on `window.__TANGERINE_UPDATER_MOCK__` — the component's
// real lazy import naturally fails in jsdom; we fall back to the mock
// when present. This requires a tiny addition in UpdaterCheck.tsx.

beforeEach(() => {
  useStore.setState((s) => ({ ui: { ...s.ui, welcomed: true } }));
  // Reset any leftover mock from prior tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__TANGERINE_UPDATER_MOCK__;
});

describe("UpdaterCheck (wave 25)", () => {
  it("renders the install banner when the bridge mock returns an update", async () => {
    // Inject a synthetic mock; the component checks for this BEFORE
    // attempting the lazy import.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__TANGERINE_UPDATER_MOCK__ = {
      check: async () => ({
        version: "1.12.1",
        date: "2026-04-27",
        body: "Bug fixes and polish.",
        downloadAndInstall: vi.fn(async () => {}),
      }),
    };

    render(<UpdaterCheck />);

    await waitFor(
      () => {
        const banner = screen.getByTestId("updater-banner");
        expect(banner).toBeInTheDocument();
        expect(banner.getAttribute("data-update-version")).toBe("1.12.1");
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("updater-install")).toBeInTheDocument();
    expect(screen.getByTestId("updater-dismiss")).toBeInTheDocument();
  });

  it("renders nothing when the updater bridge is unavailable (graceful degrade)", async () => {
    // No mock installed → component's lazy import will fail in jsdom.
    // Swallow path must never render the banner.
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(<UpdaterCheck />);

    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("[data-testid='updater-banner']")).toBeNull();
    consoleSpy.mockRestore();
  });

  it("does not check for updates until welcomed === true", async () => {
    useStore.setState((s) => ({ ui: { ...s.ui, welcomed: false } }));
    const checkFn = vi.fn(async () => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__TANGERINE_UPDATER_MOCK__ = { check: checkFn };

    const { container } = render(<UpdaterCheck />);

    await new Promise((r) => setTimeout(r, 50));
    expect(checkFn).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='updater-banner']")).toBeNull();
  });
});
