/**
 * Crash recovery: reload mid-review preserves the meetings list state and the
 * review page reloads fresh blocks (mock fixtures regenerate idempotently).
 */
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TMI_MOCK__ = { config: { schema_version: 1 } };
  });
});

test("reload during review re-fetches blocks without losing the meeting", async ({ page }) => {
  await page.goto("/meetings/2026-04-24-david-sync/review");
  await expect(page.getByTestId("rv-0")).toBeVisible();

  // Decide one block, then "crash" (reload).
  await page.getByTestId("rv-block-1").click();
  await page.getByTestId("diff-approve").click();
  await page.reload();

  // The page rehydrates from getReviewJson; blocks visible again.
  await expect(page.getByTestId("rv-0")).toBeVisible();
  await expect(page.getByTestId("rv-block-list")).toBeVisible();
  await expect(page.getByTestId("rv-block-1")).toBeVisible();
});

test("hard navigate to nonexistent meeting still renders shell, not crash", async ({ page }) => {
  await page.goto("/meetings/nonexistent-meeting");
  // MD-0 falls back to first fixture entry — no white screen.
  await expect(page.getByTestId("md-0")).toBeVisible();
});
