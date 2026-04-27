import { test, expect } from "@playwright/test";
// === wave 5-γ ===
import { seedStubSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedStubSession(page);
});

test("approve all blocks then merge", async ({ page }) => {
  await page.goto("/meetings/2026-04-24-david-sync/review");
  await expect(page.getByTestId("rv-0")).toBeVisible();
  await expect(page.getByTestId("rv-block-list")).toBeVisible();

  // Three fixture blocks
  for (const id of [1, 2, 3]) {
    await page.getByTestId(`rv-block-${id}`).click();
    await page.getByTestId("diff-approve").click();
  }

  // Progress should reflect 3/3
  await expect(page.getByTestId("rv-progress")).toContainText("3 of 3 reviewed");

  // Merge button now enabled
  const merge = page.getByTestId("rv-merge");
  await expect(merge).toBeEnabled();
  await merge.click();

  // After mock applyMeeting, lands on AP-0 with applied=1
  await expect(page).toHaveURL(/applied=1/);
  await expect(page.getByTestId("ap-0")).toBeVisible();
});

test("keyboard shortcuts navigate and decide", async ({ page }) => {
  await page.goto("/meetings/2026-04-24-david-sync/review");
  await expect(page.getByTestId("rv-0")).toBeVisible();

  // a -> approve block 1, advance
  await page.keyboard.press("a");
  await expect(page.getByTestId("rv-progress")).toContainText("1 of 3");

  // r -> reject block 2
  await page.keyboard.press("r");
  await expect(page.getByTestId("rv-progress")).toContainText("2 of 3");
});

test("transcript ref opens modal", async ({ page }) => {
  await page.goto("/meetings/2026-04-24-david-sync/review");
  await page.getByTestId("ref-L47").click();
  await expect(page.getByTestId("rv-ref-modal")).toBeVisible();
});
