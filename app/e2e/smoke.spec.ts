import { test, expect } from "@playwright/test";

// === wave 5-γ ===
// Legacy v1.6 first-launch wizard scaffold. The "Welcome to Tangerine AI Teams"
// copy moved from the / route to the WelcomeOverlay modal in Wave 4-C, and the
// auth gate now intercepts `/` for unauthenticated visits. The active smoke
// suite at `playwright-tests/smoke.spec.ts` covers the 8 primary routes
// post-auth — that's what this spec was originally trying to be a placeholder
// for. Skip rather than delete so the legacy scenario template stays in tree.
test.skip(
  true,
  "wave 5-γ: replaced by playwright-tests/smoke.spec.ts (8-route post-auth smoke).",
);

test("welcome screen renders on first launch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Welcome to Tangerine AI Teams/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Get started/i })).toBeVisible();
});
