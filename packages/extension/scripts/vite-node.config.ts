import { defineConfig } from "vite";

/**
 * Minimal config for running scripts/ under vite-node.
 *
 * Deliberately does NOT load the @crxjs/vite-plugin plugin — these scripts build source files,
 * they don't build the extension. `noExternal` is required because
 * @material/material-color-utilities ships ESM with extensionless relative
 * imports, which native Node cannot resolve; Vite must process it instead of
 * handing it off.
 */
export default defineConfig({
  ssr: { noExternal: ["@material/material-color-utilities"] },
});
