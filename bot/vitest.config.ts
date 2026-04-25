import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
    exclude: ["tests/fixtures/**"],
    testTimeout: 10_000,
  },
});
