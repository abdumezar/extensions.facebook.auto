import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import devManifest, { buildManifest, CONTENT_SCRIPT_ENTRY, contentScriptMatches } from "./manifest.config.js";
import { classicContentScript } from "./scripts/lib/classicContentScript.js";
import { e2eInjection } from "./scripts/lib/e2eBuild.js";

const rootDir = import.meta.dirname;

const alias = {
  "@nashir/shared": resolve(rootDir, "../shared/src/index.ts"),
  "@": resolve(rootDir, "src"),
};

export default defineConfig(({ mode, command }) => ({
  resolve: { alias },
  // `null` outside an end-to-end build, so the code that reads it folds away.
  define: { __NASHIR_E2E__: mode === "e2e" ? JSON.stringify(e2eInjection(process.env)) : "null" },
  plugins: [
    react(),
    // A release builds the content script on its own, as one classic script (see the plugin
    // for why); the dev server keeps the manifest as written so the script hot-reloads.
    crx({ manifest: command === "build" ? buildManifest : devManifest }),
    classicContentScript({
      root: rootDir,
      entry: CONTENT_SCRIPT_ENTRY,
      scripts: contentScriptMatches,
      alias,
    }),
  ],
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
