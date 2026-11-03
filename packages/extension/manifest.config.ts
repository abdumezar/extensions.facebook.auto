import { defineManifest } from "@crxjs/vite-plugin";

/**
 * MV3 manifest. Permissions are kept deliberately minimal:
 *  - `cookies`  : needed for the multi-account cookie-swap engine.
 *  - `alarms`   : drives the durable, SW-eviction-safe campaign loop.
 *  - `offscreen`: reserved for future DOM work off the service worker.
 *  - `scripting`: reads the doc_ids Facebook's own page is using (see DocIdHarvester).
 *
 * `declarativeNetRequest` rules are added dynamically at runtime (see dnrManager) using
 * `chrome.runtime.id`, never a hardcoded extension id.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Nashir — Facebook Group Auto Poster",
  short_name: "Nashir",
  description:
    "ناشِر — انشر إلى مجموعات فيسبوك المتعددة بأمان. Arabic-first bulk poster for Facebook groups.",
  version: "0.1.0",
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

  content_scripts: [
    {
      matches: ["*://*.facebook.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],

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

  host_permissions: ["*://*.facebook.com/*", "*://upload.facebook.com/*"],

  web_accessible_resources: [
    {
      resources: ["src/dashboard/index.html"],
      matches: ["*://*.facebook.com/*"],
    },
  ],
});
