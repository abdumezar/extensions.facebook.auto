import { build, type Plugin } from "vite";
import { resolve } from "node:path";

type Manifest = Record<string, unknown>;

/** A `content_scripts` entry minus the file list, which this plugin supplies. */
export type ContentScriptMatch = { matches: string[] } & Record<string, unknown>;

/** Where the built content script lands in the extension, next to `manifest.json`. */
export const CONTENT_SCRIPT_FILE = "content-script.js";

/**
 * Builds the content script as one classic script and points the manifest at it.
 *
 * The build plugin turns a content script that shares code with another entry (here the
 * message schemas in @nashir/shared) into a loader that `import()`s a chunk. That needs
 * the loader and the chunk to be web-accessible to the page, and with a dynamic URL the
 * loader cannot reach its own chunk at all. An IIFE with everything inlined needs neither,
 * so the manifest ends up with no `web_accessible_resources`.
 *
 * Give the build plugin a manifest without `content_scripts` and list this after `crx()`.
 * Build only: the dev server keeps the plugin's own handling, which hot-reloads.
 */
export function classicContentScript(options: {
  root: string;
  entry: string;
  scripts: ContentScriptMatch[];
  alias?: Record<string, string>;
}): Plugin & { renderCrxManifest: <T extends Manifest>(manifest: T) => T } {
  return {
    name: "nashir:classic-content-script",
    apply: "build",
    enforce: "post",

    // Called by @crxjs/vite-plugin on every plugin while it assembles the final manifest.
    renderCrxManifest(manifest) {
      return { ...manifest, content_scripts: options.scripts.map((script) => ({ ...script, js: [CONTENT_SCRIPT_FILE] })) };
    },

    async generateBundle() {
      const result = await build({
        configFile: false,
        root: options.root,
        logLevel: "warn",
        resolve: { alias: options.alias },
        // Library mode leaves `process.env.NODE_ENV` as written; a page has no `process`.
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          write: false,
          target: "es2022",
          copyPublicDir: false,
          lib: { entry: resolve(options.root, options.entry), formats: ["iife"], name: "nashirContent", fileName: () => CONTENT_SCRIPT_FILE },
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      });

      const outputs = (Array.isArray(result) ? result : [result as { output: unknown[] }]).flatMap(
        (bundle) => (bundle as { output: { type: string; code?: string }[] }).output,
      );
      const chunks = outputs.filter((file) => file.type === "chunk");
      if (chunks.length !== 1) throw new Error(`The content script built to ${chunks.length} files; it must be one.`);
      this.emitFile({ type: "asset", fileName: CONTENT_SCRIPT_FILE, source: chunks[0]!.code ?? "" });
    },
  };
}
