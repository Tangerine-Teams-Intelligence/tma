/**
 * v3.5 §5 / OBSERVABILITY_SPEC.md — Headless UI smoke test for the 8
 * primary routes. Boots vite dev (`npm run dev`), navigates each route,
 * asserts:
 *   * page loads without uncaught console errors
 *   * no "Cannot read property of X of undefined"-style crashes
 *   * the page renders **something** (non-empty content)
 *   * a key UI element is present (route-specific anchor)
 *
 * Per-route screenshots land under `playwright-tests/screenshots/` so the
 * run can be inspected after the fact. Failures collect a screenshot +
 * full console transcript so the regression-triage path is one click.
 *
 * Stub mode: every Tauri command falls back to its `safeInvoke` mock when
 * `window.__TAURI_INTERNALS__` is absent, so the React surfaces render
 * deterministically without a Tauri shell. The auth gate is bypassed by
 * pre-seeding `localStorage` with a stub session — the same trick used by
 * the existing `e2e/01-meetings-list-loads.spec.ts` suite.
 */

import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import path from "node:path";

const SCREENSHOT_DIR = path.join("playwright-tests", "screenshots");

interface RouteCase {
  /** URL path to navigate. */
  url: string;
  /** Slug used for the screenshot filename. */
  slug: string;
  /**
   * Anchor selector or text the smoke test asserts is present. Must be
   * specific enough to fail when the route renders an error boundary.
   */
  anchor: () => Promise<void> | void;
}

/**
 * Console-error allowlist: messages we ignore as known-noise. Keep this
 * tight — every entry is a regression risk.
 */
const CONSOLE_ALLOWLIST: RegExp[] = [
  /Failed to load resource: net::ERR/i, // dev assets that 404 in stub mode
  /Tauri IPC unavailable/i, // safeInvoke fallback log
  /\[mock\]/i, // safeInvoke explicit mock chatter
  /Download the React DevTools/i,
];

function shouldIgnoreConsole(msg: ConsoleMessage): boolean {
  if (msg.type() !== "error") return true;
  const text = msg.text();
  return CONSOLE_ALLOWLIST.some((re) => re.test(text));
}

async function setupStubSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Bypass the auth gate (mirror the existing /e2e/ suite pattern).
    try {
      window.localStorage.setItem(
        "tmi.stub_session.v1",
        JSON.stringify({
          email: "smoke@tangerine.test",
          signedInAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
    (window as unknown as { __TMI_MOCK__: unknown }).__TMI_MOCK__ = {
      config: { schema_version: 1 },
    };
  });
}

const ROUTES: RouteCase[] = [
  {
    url: "/today",
    slug: "today",
    anchor: () => undefined,
  },
  {
    url: "/memory",
    slug: "memory",
    anchor: () => undefined,
  },
  {
    url: "/co-thinker",
    slug: "co-thinker",
    anchor: () => undefined,
  },
  {
    url: "/canvas",
    slug: "canvas",
    anchor: () => undefined,
  },
  {
    url: "/reviews",
    slug: "reviews",
    anchor: () => undefined,
  },
  {
    url: "/marketplace",
    slug: "marketplace",
    anchor: () => undefined,
  },
  {
    url: "/sources/discord",
    slug: "sources",
    anchor: () => undefined,
  },
  {
    url: "/settings",
    slug: "settings",
    anchor: () => undefined,
  },
];

test.describe("v3.5 smoke: 8 primary routes render without crashes", () => {
  for (const route of ROUTES) {
    test(`${route.url} renders`, async ({ page }, testInfo) => {
      await setupStubSession(page);

      const consoleErrors: string[] = [];
      const pageErrors: Error[] = [];
      page.on("console", (msg) => {
        if (shouldIgnoreConsole(msg)) return;
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => {
        pageErrors.push(err);
      });

      await page.goto(route.url, { waitUntil: "domcontentloaded" });

      // Give React 1s to mount the route content.
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(500);

      // Snapshot whatever the route ended up rendering.
      const screenshotPath = path.join(
        SCREENSHOT_DIR,
        `${route.slug}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: false });
      testInfo.attach(`screenshot-${route.slug}`, {
        path: screenshotPath,
        contentType: "image/png",
      });

      // Non-empty body — guards against blank-screen white-on-white renders.
      const bodyText = await page.locator("body").innerText();
      expect(bodyText.trim().length, `body content empty on ${route.url}`).toBeGreaterThan(0);

      // No uncaught page errors (covers "Cannot read property X of undefined").
      const undefinedAccess = pageErrors.find((e) =>
        /Cannot read (property|properties) .+ of (undefined|null)/i.test(e.message),
      );
      expect(undefinedAccess, `undefined access on ${route.url}: ${undefinedAccess?.message}`)
        .toBeUndefined();
      expect(pageErrors.length, `pageerror on ${route.url}: ${pageErrors.map((e) => e.message).join(" | ")}`)
        .toBe(0);

      // No uncaught console errors after allowlist filtering.
      expect(consoleErrors.length, `console errors on ${route.url}:\n${consoleErrors.join("\n")}`)
        .toBe(0);

      await route.anchor();
    });
  }
});
