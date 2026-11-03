// A stand-in for the `chrome` global, so the real dashboard runs in an ordinary tab.
//
// Importing this module installs it, which is why it must be the first import of the
// entry: some dashboard modules read `chrome` as soon as they are evaluated.
//
// The service worker is replaced by a table of answers built from `seed.js`. A request
// type that is not in the table gets `{ ok: true, data: null }` and a console warning,
// so a page that starts asking for something new shows up in the capture log.

import { buildSeed } from "./seed.js";

// The clock is stopped at one moment, so "synced 4 min ago", the log times and the run
// countdown read the same on every run and every machine. capture.mjs fixes the time
// zone to match.
const FROZEN_NOW = Date.parse("2026-11-03T10:00:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FROZEN_NOW);
    else super(...args);
  }

  static now() {
    return FROZEN_NOW;
  }
};

const params = new URLSearchParams(window.location.search);

/** The scenario this page was opened for; `main.js` reads the same object. */
export const scenario = {
  route: params.get("route") ?? "dashboard",
  lang: params.get("lang") === "en" ? "en" : "ar",
  theme: params.get("theme") === "dark" ? "dark" : "light",
  run: params.get("run") === "1",
  update: params.get("update") === "1",
};

export const seed = buildSeed({ ...scenario, now: FROZEN_NOW });

/** `chrome.storage.local`, in memory, with the change events the pages listen for. */
function createStorage(initial) {
  const data = new Map(Object.entries(initial));
  const listeners = new Set();
  const area = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const name of names) if (data.has(name)) out[name] = data.get(name);
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: value };
        data.set(key, value);
      }
      for (const listener of listeners) listener(changes, "local");
    },
  };
  const onChanged = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  return { local: area, onChanged };
}

/** One answer per dashboard request. Pure reads: nothing here changes what the next read says. */
function answer(request) {
  switch (request.type) {
    case "GET_VERSION":
      return "1.0.0";
    case "LIST_ACCOUNTS":
      return [seed.account];
    case "GET_SESSION_STATUS":
      return seed.session;
    case "BOOTSTRAP_SESSION":
      return { session: seed.session, groups: seed.groups };
    case "GET_CACHED_GROUPS":
    case "SYNC_GROUPS_IF_STALE":
      return { accountId: request.accountId ?? "current", groups: seed.groups, syncedAt: seed.syncedAt };
    case "GET_RUN_SNAPSHOT":
      return seed.snapshot;
    case "GET_RUN_RESULTS":
      return [];
    case "COUNT_FB_TABS":
      return { count: 1 };
    case "GET_UPDATE_STATE":
    case "CHECK_FOR_UPDATE":
      return seed.update;
    case "GET_BUSY_STATE":
      return { busy: false };
    case "GET_DOC_IDS":
      return seed.docIds;
    case "GET_GOVERNOR_SNAPSHOT":
      return seed.governor;
    case "GET_EXTRACTION_STATE":
      return seed.extraction;
    case "QUERY_AUDIENCE": {
      const needle = (request.search ?? "").toLowerCase();
      const rows = seed.audience.filter(
        (row) =>
          (!request.withContactOnly || row.contacts.length > 0) &&
          (!needle || row.name.toLowerCase().includes(needle)),
      );
      return { rows, total: rows.length };
    }
    case "GET_ENGAGEMENT":
      return { enabled: false, due: 0 };
    default:
      console.warn(`[screenshots] no seeded answer for ${request.type}`);
      return null;
  }
}

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ name: "Nashir", version: "1.0.0", manifest_version: 3 }),
    sendMessage: async (request) => ({ ok: true, data: answer(request) }),
    reload: () => {},
  },
  storage: createStorage({ "nashir:logs": seed.logs }),
  tabs: { create: async () => ({}) },
};
