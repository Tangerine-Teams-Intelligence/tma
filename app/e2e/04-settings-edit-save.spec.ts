import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TMI_MOCK__ = { config: { schema_version: 1 } };
  });
});

test("settings tabs render and save persists optimistically", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("st-0")).toBeVisible();

  // General
  await page.getByTestId("st-meetings-repo").fill("C:\\Users\\you\\meets");
  await page.getByTestId("st-log-level").selectOption("debug");

  // Switch to Adapters tab and tweak chunk seconds
  await page.getByTestId("st-tab-adapters").click();
  await page.getByTestId("adp-chunk-seconds").fill("15");

  // Save
  await page.getByTestId("st-save").click();

  // Saved indicator (mock setConfig resolves instantly)
  await expect(page.getByText(/Saved/)).toBeVisible();
});

test("debug bundle export records result", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("st-tab-advanced").click();
  await page.getByTestId("st-export-bundle").click();
  await expect(page.getByTestId("st-export-result")).toBeVisible();
});
