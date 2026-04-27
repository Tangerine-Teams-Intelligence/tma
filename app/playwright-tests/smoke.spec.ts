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
 * deterministically without a Tauri shell.
 *
 * Auth bypass: the auth gate in `lib/auth.ts` reads the localStorage key
 * `tangerine.auth.stubSession` (NOT `tmi.stub_session.v1` — that was a
 * stale guess from the v3.5 wave-1 draft). We seed that key directly via
 * `addInitScript` so every navigation lands inside the AppShell instead
 * of bouncing to /auth. We also seed `memoryConfig.mode = "solo"` in the
 * persisted zustand store so /memory doesn't redirect to
 * /onboarding-team on first paint.
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
  anchor: (page: Page) => Promise<void>;
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
  /VITE_SUPABASE_URL/i, // stub-mode banner from supabase.ts
  /\[supabase\]/i, // stub-mode banner from supabase.ts
];

function shouldIgnoreConsole(msg: ConsoleMessage): boolean {
  if (msg.type() !== "error") return true;
  const text = msg.text();
  return CONSOLE_ALLOWLIST.some((re) => re.test(text));
}

/**
 * Pre-seed the auth gate + zustand store so every smoke navigation lands
 * inside the AppShell. Two keys are written:
 *
 *   1. `tangerine.auth.stubSession` — read by `useAuth()` in lib/auth.ts.
 *      Presence flips `signedIn` to true, so the App.tsx gate at line 129
 *      stops redirecting to /auth.
 *
 *   2. `tangerine.skills` (zustand persist key per lib/store.ts:1047)
 *      — pre-seeds `ui.memoryConfig.mode = "solo"` so /memory doesn't
 *      bounce to /onboarding-team. We also pin `currentUser` and
 *      `samplesSeeded` so the routes render their stable empty state.
 *
 * If the zustand persist key changes (e.g. version bump) the second seed
 * becomes a no-op and zustand falls back to defaults — auth still works,
 * /memory just briefly redirects. That's acceptable: the smoke goal is
 * "route mounts without crashing", not "memory tree renders content".
 */
async function setupStubSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // (1) Auth gate bypass — actual key per lib/auth.ts.
    try {
      window.localStorage.setItem(
        "tangerine.auth.stubSession",
        JSON.stringify({
          email: "smoke@tangerine.test",
          signedInAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }

    // (2) Zustand persist seed — keeps /memory from redirecting to
    // /onboarding-team. Shape mirrors `partialize` in lib/store.ts.
    try {
      const persisted = {
        state: {
          ui: {
            memoryConfig: {
              mode: "solo",
              personalDirEnabled: true,
            },
            currentUser: "smoke",
            samplesSeeded: true,
            sampleBannerDismissed: true,
          },
          skills: { meetingConfig: {} },
        },
        version: 0,
      };
      window.localStorage.setItem(
        "tangerine.skills",
        JSON.stringify(persisted),
      );
    } catch {
      /* ignore */
    }

    // (3) Tauri command mock seed used by the existing /e2e/ suite.
    (window as unknown as { __TMI_MOCK__: unknown }).__TMI_MOCK__ = {
      config: { schema_version: 1 },
    };
  });
}

const ROUTES: RouteCase[] = [
  {
    url: "/today",
    slug: "today",
    // /today renders <h1>{prettyDate(today)}</h1> next to a "Today"
    // ti-section-label. Match either the pretty date heading OR the
    // breadcrumb "~ /today" text — both are present iff the route mounted.
    anchor: async (page) => {
      await expect(page.locator("text=~ /today").first()).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("text=Workflow").first()).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/memory",
    slug: "memory",
    // /memory mounts inside AppShell; the breadcrumb "~ /memory" or the
    // sidebar's "Memory" tab label is the safest anchor (the file tree
    // itself is virtualized + may be empty in stub mode).
    anchor: async (page) => {
      // Either the route header OR the AppShell sidebar's "Memory" link.
      const memoryHeader = page.locator("text=/memory|Memory/").first();
      await expect(memoryHeader).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/co-thinker",
    slug: "co-thinker",
    // co-thinker renders an empty-state CTA "Co-thinker hasn't started
    // thinking yet." when the brain doc is empty — the stub safeInvoke
    // returns "" so this is the deterministic state.
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /Co-thinker/i, level: 1 }),
      ).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/canvas",
    slug: "canvas",
    // /canvas index renders <h1>Canvas</h1> + "No canvases yet." empty
    // state when canvasListProjects() returns []. Match the heading.
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /^Canvas$/, level: 1 }),
      ).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/reviews",
    slug: "reviews",
    // /reviews shows "Reviews" h1 + filter chips. Empty state copy is
    // "No open reviews. The co-thinker will propose decisions on the
    // next heartbeat." in stub mode.
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /Reviews/i }),
      ).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/marketplace",
    slug: "marketplace",
    // /marketplace renders <h1>Marketplace</h1> + the "Coming live when
    // CEO triggers launch gate" stub-mode banner.
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /Marketplace/i }),
      ).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/sources/discord",
    slug: "sources",
    // /sources/discord dispatches to DiscordSourceRoute via SourceDetailRoute,
    // which renders <h1>Set up the Discord source</h1>.
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /Set up the Discord source/i }),
      ).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    url: "/settings",
    slug: "settings",
    // /settings renders <h1>Settings</h1> + tabs nav (data-testid="st-0").
    anchor: async (page) => {
      await expect(
        page.getByRole("heading", { name: /^Settings$/, level: 1 }),
      ).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId("st-0")).toBeVisible({ timeout: 5_000 });
    },
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

      // Auth-gate sanity: the auth screen's headline copy is unique to
      // /auth. If we still see it after the stub-session seed, the
      // bypass broke and the rest of the assertions are vacuous.
      const taglineLocator = page.locator(
        "text=Align every AI tool on your team with your team's actual workflow",
      );
      const stillOnAuth = await taglineLocator.first().isVisible().catch(() => false);
      expect(
        stillOnAuth,
        `still on /auth after stub-session seed for ${route.url} — auth bypass broke`,
      ).toBe(false);

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

      // Per-route anchor — the real "did this route mount?" check.
      await route.anchor(page);
    });
  }
});
