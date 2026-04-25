import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TMI_MOCK__ = { config: { schema_version: 1 } };
  });
});

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
