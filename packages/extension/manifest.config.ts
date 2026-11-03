import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";
import { e2eManifest } from "./scripts/lib/e2eBuild.js";
import { EXTENSION_KEY } from "./src/update/extensionKey.js";

/**
 * MV3 manifest. Permissions are kept deliberately minimal:
 *  - `cookies`  : needed for the multi-account cookie-swap engine.
 *  - `alarms`   : drives the durable, SW-eviction-safe campaign loop.
 *  - `offscreen`: reserved for future DOM work off the service worker.
 *  - `scripting`: reads the doc_ids Facebook's own page is using (see DocIdHarvester).
 *
 * The `key` pins the extension id (`jkfmfkdijopiodgfbdnpkileohkojojk`). It is the public half
 * of a throwaway pair, so it is safe to commit; it is what lets an update replace the files
 * of an install without Chrome treating the result as a different extension.
 *
 * `declarativeNetRequest` rules are added dynamically at runtime (see dnrManager) using
 * `chrome.runtime.id`, never a hardcoded extension id.
 */
const common = {
  manifest_version: 3 as const,
  name: "Nashir — Facebook Group Auto Poster",
  short_name: "Nashir",
  description:
    "ناشِر — انشر إلى مجموعات فيسبوك المتعددة بأمان. Arabic-first bulk poster for Facebook groups.",
  version: pkg.version,
  key: EXTENSION_KEY,
  minimum_chrome_version: "116",

  icons: {
    "16": "src/assets/icons/16.png",
    "32": "src/assets/icons/32.png",
    "48": "src/assets/icons/48.png",
    "128": "src/assets/icons/128.png",
  },

  action: {
    default_title: "Nashir",
    default_popup: "src/popup/index.html",
  },

  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },

  permissions: [
    "tabs",
    "storage",
    "unlimitedStorage",
    "cookies",
    "alarms",
    "notifications",
    "offscreen",
    "declarativeNetRequest",
    "scripting",
  ],

  // Facebook, plus GitHub for the update check and the release download. A download from
  // github.com is redirected to the asset hosts, which need their own entries.
  host_permissions: [
    "*://*.facebook.com/*",
    "*://upload.facebook.com/*",
    "https://api.github.com/*",
    "https://github.com/*",
    "https://objects.githubusercontent.com/*",
    "https://release-assets.githubusercontent.com/*",
  ],

  // Nothing on facebook.com needs a page of this extension: the dashboard is opened by the
  // service worker in its own tab, and the content script is built as one classic script
  // (see scripts/lib/classicContentScript.ts), so there is no chunk to expose either. No
  // `web_accessible_resources` entry is declared, and the release packer refuses one for
  // facebook.com.
};

/** The content script's entry file, and where it runs. The built file's name is not here. */
export const CONTENT_SCRIPT_ENTRY = "src/content/index.ts";
export const contentScriptMatches = [
  { matches: ["*://*.facebook.com/*"], run_at: "document_idle" as const, all_frames: false },
];

/** The dev server's manifest: the content script as an entry, so the dev plugin hot-reloads it. */
export default defineManifest({
  ...common,
  content_scripts: contentScriptMatches.map((script) => ({ ...script, js: [CONTENT_SCRIPT_ENTRY] })),
});

/**
 * The build's manifest: no content script, because the build adds the one it makes itself.
 * Only `--mode e2e` changes anything else (see scripts/lib/e2eBuild.ts).
 */
export const buildManifest = defineManifest(({ mode }) =>
  mode === "e2e" ? e2eManifest(common, process.env) : common,
);
