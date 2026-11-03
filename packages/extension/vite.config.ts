import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import manifest from "./manifest.config.js";

const rootDir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@nashir/shared": resolve(rootDir, "../shared/src/index.ts"),
      "@": resolve(rootDir, "src"),
    },
  },
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    sourcemap: true,
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
});
