import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import manifest from "./manifest.config.js";
import { dynamicResourceUrls } from "./scripts/lib/dynamicWar.js";

const rootDir = import.meta.dirname;

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@nashir/shared": resolve(rootDir, "../shared/src/index.ts"),
      "@": resolve(rootDir, "src"),
    },
  },
  // After crx(): it writes every web-accessible entry with a fixed URL, this turns that off.
  plugins: [react(), crx({ manifest }), dynamicResourceUrls()],
  build: {
    target: "es2022",
    // Maps are for debugging; a release should not ship them (they double its size and
    // expose the source layout to any page that can fetch a web-accessible file).
    sourcemap: mode === "e2e",
    rollupOptions: {
      input: {
        // Extra HTML entry points not referenced by the manifest action/background.
        dashboard: resolve(rootDir, "src/dashboard/index.html"),
      },
    },
  },
  server: {
    port: 5199,
    strictPort: true,
    hmr: { port: 5199 },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
