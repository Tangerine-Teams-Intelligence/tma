import { test, expect } from "@playwright/test";
// === wave 5-γ ===
import { seedStubSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedStubSession(page);
});

// === wave 5-γ ===
// Same deprecation as 01-meetings-list-loads.spec.ts: `/meetings` redirects to
// `/sources/discord`, and the `new-meeting-button` testid was retired with
// the meetings list UI. Re-enable once Wave 5-α lands the v2.0 meetings flow.
test.skip(
  true,
  "wave 5-γ: /meetings + new-meeting-button deprecated in v1.9.x → v2.0 reshape. " +
    "Tauri-app smoke at playwright-tests/smoke.spec.ts is the active gate.",
);

test("creating a meeting opens the modal and navigates to detail", async ({ page }) => {
  await page.goto("/meetings");
  await page.getByTestId("new-meeting-button").click();

  const modal = page.getByTestId("nm-0");
  await expect(modal).toBeVisible();

  await page.getByTestId("nm-title").fill("Quick standup");
  // Slug preview should reflect the title.
  await expect(page.getByTestId("nm-slug")).toContainText("quick-standup");

  await page.getByTestId("nm-submit").click();

  // Mock createMeeting returns today-quick-standup; URL reflects it.
  await expect(page).toHaveURL(/\/meetings\/\d{4}-\d{2}-\d{2}-quick-standup$/);
});

test("submit disabled when title is empty", async ({ page }) => {
  await page.goto("/meetings");
  await page.getByTestId("new-meeting-button").click();
  await expect(page.getByTestId("nm-submit")).toBeDisabled();
});
