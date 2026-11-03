import { defineWorkspace } from "vitest/config";
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
 * Vitest 2.x configures this through a workspace file; `test.projects` is Vitest 3+
 * and does nothing here. The `test` block in vite.config.ts is superseded by this.
 */
export default defineWorkspace([
  {
    resolve: { alias },
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
    plugins: [react()],
    resolve: { alias },
    test: {
      name: "dom",
      environment: "jsdom",
      include: ["src/**/*.test.tsx"],
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
    },
  },
]);
