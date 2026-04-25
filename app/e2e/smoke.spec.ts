import { test, expect } from "@playwright/test";

// Scaffold smoke test. T2 will replace this with the §12.3 scenario suite:
//   1. First-run wizard end-to-end
//   2. Full meeting cycle (stub modes)
//   3. Settings round-trip
//   4. Meetings list state
//   5. Live close grace
test("welcome screen renders on first launch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Welcome to Tangerine AI Teams/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Get started/i })).toBeVisible();
});
