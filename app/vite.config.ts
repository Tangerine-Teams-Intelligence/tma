import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

// === wave 6 === BUG #3 — inject the package.json version into the bundle so
// the WelcomeOverlay version-aware re-show check can compare the running
// build's version against the persisted `lastWelcomedVersion`. We read it
// at config-load time (no extra build step required).
const PKG_VERSION: string = (() => {
  try {
    const raw = readFileSync(path.resolve(__dirname, "package.json"), "utf-8");
    const obj = JSON.parse(raw) as { version?: string };
    return obj.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Tauri expects a fixed dev server port and does not handle HMR over wss in the
// embedded webview, so we lock the host to localhost.
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: {
      // Don't watch the Rust side — Tauri reloads it itself.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    css: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "src-tauri", "e2e/**"],
  },
}));
