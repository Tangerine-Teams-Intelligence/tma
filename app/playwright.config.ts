import { defineConfig } from "@playwright/test";

// T2 fills in the actual scenarios; T1 ships only the scaffold.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
