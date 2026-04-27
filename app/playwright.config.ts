import { defineConfig } from "@playwright/test";

/**
 * v3.5 wave 2: split into two projects so the legacy `/e2e/` suite (T2's
 * scenario coverage) and the new `/playwright-tests/` smoke suite can ship
 * side-by-side. Run both with `npm run test:e2e`; run smoke-only with
 * `npm run smoke` (per V3_5_SPEC.md / OBSERVABILITY_SPEC.md).
 *
 * The `webServer` boots `npm run dev` (vite, port 1420) and waits for the
 * URL to be reachable before tests start. Both projects share the same
 * dev server.
 */
export default defineConfig({
  // Multiple test directories via projects below; this top-level testDir
  // stays at "./e2e" so historical `npx playwright test` invocations keep
  // running the original suite.
  testDir: "./e2e",
  timeout: 30_000,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "e2e",
      testDir: "./e2e",
      use: { baseURL: "http://localhost:1420" },
    },
    {
      name: "smoke",
      testDir: "./playwright-tests",
      use: { baseURL: "http://localhost:1420" },
    },
  ],
});
