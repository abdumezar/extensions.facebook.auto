// Dev-server config for the screenshot harness. Separate from the extension's own
// vite.config.ts on purpose: no extension plugin, no manifest, nothing that could put
// the harness into a build.

import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
// The extension package is the root, so the Tailwind and PostCSS config beside it are
// found and the dashboard's own `/src/...` paths mean the same thing here as there.
const root = resolve(here, "../..");

export default defineConfig({
  root,
  // Apart from the extension's dev server, so the two never share a stale pre-bundle.
  cacheDir: resolve(root, "node_modules/.vite-screenshots"),
  resolve: {
    alias: {
      "@nashir/shared": resolve(root, "../shared/src/index.ts"),
      "@": resolve(root, "src"),
    },
  },
  define: { __NASHIR_E2E__: "null" },
  plugins: [react()],
  optimizeDeps: { entries: ["scripts/screenshots/*.html"] },
  server: { host: "127.0.0.1" },
});
