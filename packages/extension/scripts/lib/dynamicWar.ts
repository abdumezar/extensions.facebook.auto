import type { Plugin } from "vite";

type Manifest = { web_accessible_resources?: Record<string, unknown>[] } & Record<string, unknown>;

/**
 * Every `web_accessible_resources` entry gets `use_dynamic_url: true`.
 *
 * The extension id is pinned by the manifest `key`, so it is the same on every machine. A
 * plain URL for a content-script file would therefore be the same everywhere too, and any
 * web page could fetch it to learn the extension is installed. A dynamic URL is different
 * per browser profile. The build plugin that generates the entries always writes `false`,
 * so this runs after it.
 */
export function withDynamicUrls<T extends Manifest>(manifest: T): T {
  if (!manifest.web_accessible_resources) return manifest;
  return {
    ...manifest,
    web_accessible_resources: manifest.web_accessible_resources.map((entry) => ({ ...entry, use_dynamic_url: true })),
  };
}

/**
 * Vite plugin applying `withDynamicUrls` to the final manifest. List it after `crx()`.
 *
 * It hooks `renderCrxManifest`, which @crxjs/vite-plugin calls on every plugin in order
 * while it assembles the manifest, rather than `generateBundle`: crxjs adds `manifest.json`
 * to the output in its own `generateBundle`, after this plugin's has run. Build only; the
 * dev server needs its own wide-open entry to hot-reload.
 */
export function dynamicResourceUrls(): Plugin & { renderCrxManifest: <T extends Manifest>(manifest: T) => T } {
  return {
    name: "nashir:dynamic-resource-urls",
    apply: "build",
    enforce: "post",
    renderCrxManifest: withDynamicUrls,
  };
}
