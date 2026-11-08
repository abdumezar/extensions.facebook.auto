import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const rootDir = import.meta.dirname;

const alias = {
  "@nashir/shared": resolve(rootDir, "../shared/src/index.ts"),
  "@": resolve(rootDir, "src"),
};

/**
 * Two projects, because the suites have genuinely different needs:
 *
 *  - `node` — the engine tests. Pure TS, no DOM, no React. Unchanged from before
 *    this file existed; they are the regression signal that the M3 work stayed
 *    inside the UI layer.
 *  - `dom`  — component and browser-API tests. Needs jsdom and the React plugin.
 *
 * Vitest 4 configures this through `test.projects`. This file stands in for vite.config.ts
 * under test on purpose: that one loads the extension build plugins, which have no
 * business in a test run. Each project extends only the alias set defined here.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        // The token generator imports @material/material-color-utilities, which ships
        // ESM with extensionless relative imports that native Node cannot resolve.
        ssr: { noExternal: ["@material/material-color-utilities"] },
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          server: { deps: { inline: ["@material/material-color-utilities"] } },
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
          restoreMocks: true,
        },
      },
    ],
  },
});
