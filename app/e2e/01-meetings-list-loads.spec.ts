import { test, expect } from "@playwright/test";
// === wave 5-γ ===
import { seedStubSession } from "./_setup";

// Bypass setup wizard + auth gate. The auth gate (lib/auth.ts) redirects
// unauthenticated visits to /auth, so the legacy `__TMI_MOCK__`-only seed
// strands every test on the login screen. Shared helper seeds both keys.
test.beforeEach(async ({ page }) => {
  await seedStubSession(page);
});

// === wave 5-γ ===
// `/meetings` was retired in v1.9.x — App.tsx now does
// `<Route path="meetings" element={<Navigate to="/sources/discord" replace />} />`.
// The `MeetingsList` component still ships (referenced from /sources/discord),
// but it is no longer mounted at the URL these specs target. The forward path
// is Wave 5-α's redesigned discord-source flow + the new Tauri-app smoke at
// `playwright-tests/smoke.spec.ts`. Skip with reason; do not delete — these
// are the canonical scenario specs to port once the new URL surface stabilises.
test.skip(
  true,
  "wave 5-γ: /meetings deprecated in v1.9.x → /sources/discord redirect. " +
    "Re-enable once Wave 5-α lands the new meetings list URL. " +
    "Tauri-app smoke at playwright-tests/smoke.spec.ts covers the 8 primary routes.",
);

test("meetings list loads with fixture data", async ({ page }) => {
  await page.goto("/meetings");
  await expect(page.getByTestId("ml-0")).toBeVisible();
  await expect(page.getByTestId("meetings-list")).toBeVisible();
  await expect(page.getByText("David sync")).toBeVisible();
  await expect(page.getByText("Weekly standup")).toBeVisible();
});

test("clicking a meeting card navigates to detail", async ({ page }) => {
  await page.goto("/meetings");
  await page.getByTestId("meeting-card-2026-04-24-david-sync").click();
  await expect(page).toHaveURL(/\/meetings\/2026-04-24-david-sync$/);
  await expect(page.getByTestId("md-0")).toBeVisible();
});
