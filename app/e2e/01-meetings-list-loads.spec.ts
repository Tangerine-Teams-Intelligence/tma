import { test, expect } from "@playwright/test";

// Bypass setup wizard by injecting a stub config into window.__TMI_MOCK__.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TMI_MOCK__ = {
      config: { schema_version: 1 },
    };
  });
});

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
