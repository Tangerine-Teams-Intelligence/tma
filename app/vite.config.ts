import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri expects a fixed dev server port and does not handle HMR over wss in the
// embedded webview, so we lock the host to localhost.
export default defineConfig(async () => ({
  plugins: [react()],
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
