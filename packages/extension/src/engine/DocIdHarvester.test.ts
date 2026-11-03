import { DEFAULT_FB_RECIPE, bundledDocIds, recipeFriendlyNames } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { DocIdHarvester, isFacebookPage, type ScriptRunner } from "./DocIdHarvester.js";
import { DocIdStore } from "./DocIdStore.js";
import { harvestLookup } from "./harvestLookup.js";
import type { LoggerPort, StoragePort } from "./ports/index.js";

const REACTIONS_FIRST = "CometUFIReactionsDialogQuery";
const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
const TEN_MIN = 10 * 60_000;

function memory() {
  const map = new Map<string, unknown>();
  const storage: StoragePort = {
    async get<T>(k: string) {
      return (map.get(k) as T) ?? null;
    },
    async set(k, v) {
      map.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k) {
      map.delete(k);
    },
  };
  return { map, storage };
}

function setup(page: () => unknown) {
  const { storage, map } = memory();
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls: Array<{ tabId: number; func: unknown; args: unknown[] }> = [];
  const run: ScriptRunner = async (tabId, func, args) => {
    calls.push({ tabId, func, args });
    const out = page();
    if (out instanceof Error) throw out;
    return out;
  };
  let now = 1_700_000_000_000;
  // A fresh instance per call stands in for a restarted service worker; storage is shared.
  const make = () =>
    new DocIdHarvester({
      storage,
      store: new DocIdStore(storage, logger),
      run,
      logger,
      now: () => now,
    });
  const store = new DocIdStore(storage, logger);
  return { make, calls, store, logger, map, advance: (ms: number) => (now += ms) };
}

describe("DocIdHarvester", () => {
  it("looks the recipe's operations up in the page and records what differs", async () => {
    const t = setup(() => ({ [REACTIONS_FIRST]: "70000010", Bogus: "70000011" }));

    await t.make().maybeHarvest(7);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toEqual({
      tabId: 7,
      func: harvestLookup,
      args: [recipeFriendlyNames(DEFAULT_FB_RECIPE)],
    });
    const stored = await t.store.get();
    expect(Object.keys(stored)).toEqual([REACTIONS_FIRST]);
    expect(stored[REACTIONS_FIRST]?.docId).toBe("70000010");
    expect(stored[REACTIONS_FIRST]?.bundledAtLearn).toBe(bundled[REACTIONS_FIRST]);
  });

  it("runs at most once per tab per 10 minutes, across a fresh instance", async () => {
    const t = setup(() => ({}));

    await t.make().maybeHarvest(7);
    await t.make().maybeHarvest(7);
    expect(t.calls).toHaveLength(1);

    await t.make().maybeHarvest(8);
    expect(t.calls).toHaveLength(2);

    t.advance(TEN_MIN - 1);
    await t.make().maybeHarvest(7);
    expect(t.calls).toHaveLength(2);

    t.advance(1);
    await t.make().maybeHarvest(7);
    expect(t.calls).toHaveLength(3);
  });

  it("prunes tab entries older than an hour", async () => {
    const t = setup(() => ({}));
    await t.make().maybeHarvest(7);
    t.advance(60 * 60_000 + 1);
    await t.make().maybeHarvest(8);
    const stored = t.map.get("nashir:docIdHarvest") as Record<string, number>;
    expect(Object.keys(stored)).toEqual(["8"]);
  });

  it("does not run twice for two events racing on the same tab", async () => {
    const t = setup(() => ({}));
    const h = t.make();
    await Promise.all([h.maybeHarvest(7), h.maybeHarvest(7)]);
    expect(t.calls).toHaveLength(1);
  });

  it("treats a failed injection as spent for the window and does not throw", async () => {
    const t = setup(() => new Error("Cannot access contents of the page"));
    await expect(t.make().maybeHarvest(7)).resolves.toBeUndefined();
    await t.make().maybeHarvest(7);
    expect(t.calls).toHaveLength(1);
    expect(t.logger.warn).toHaveBeenCalled();
    expect(await t.store.get()).toEqual({});
  });

  it("sanitises hostile page output", async () => {
    const t = setup(() => ({
      [REACTIONS_FIRST]: "not-digits",
      CometUFIReactionsDialogTabContentRefetchQuery: bundled[REACTIONS_FIRST],
    }));
    await t.make().maybeHarvest(7);
    expect(await t.store.get()).toEqual({});

    const arr = setup(() => ["70000012"]);
    await arr.make().maybeHarvest(7);
    expect(await arr.store.get()).toEqual({});
  });

  it("never rejects when storage fails", async () => {
    const t = setup(() => ({}));
    const broken: StoragePort = {
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {
        throw new Error("quota");
      },
      remove: async () => {},
    };
    const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(async () => ({}));
    const h = new DocIdHarvester({ storage: broken, store: new DocIdStore(broken, logger), run, logger });
    await expect(h.maybeHarvest(7)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);

    // Stamp saved fine, but recording the result fails: still no rejection.
    const { storage } = memory();
    const failingSet: StoragePort = {
      ...storage,
      set: async (k, v) => {
        if (k === "nashir:docIds") throw new Error("quota");
        return storage.set(k, v);
      },
    };
    const h2 = new DocIdHarvester({
      storage: failingSet,
      store: new DocIdStore(failingSet, logger),
      run: async () => ({ [REACTIONS_FIRST]: "70000013" }),
      logger,
    });
    await expect(h2.maybeHarvest(7)).resolves.toBeUndefined();
  });
});

describe("isFacebookPage", () => {
  it("accepts facebook.com and its subdomains over http(s)", () => {
    for (const url of [
      "https://facebook.com/",
      "https://www.facebook.com/groups/1",
      "https://m.facebook.com/",
      "https://web.facebook.com/x",
      "https://business.facebook.com/",
      "http://www.facebook.com/",
    ]) {
      expect(isFacebookPage(url), url).toBe(true);
    }
  });

  it("rejects look-alike hosts, query-only mentions and other schemes", () => {
    for (const url of [
      "https://evilfacebook.com/",
      "https://facebook.com.evil.example/",
      "https://evil.example/?next=facebook.com",
      "https://evil.example/facebook.com",
      "https://user:pw@evil.example/@facebook.com",
      "ftp://facebook.com/",
      "chrome://facebook.com/",
      "javascript:alert('facebook.com')",
      "not a url",
      "",
      undefined,
    ]) {
      expect(isFacebookPage(url), String(url)).toBe(false);
    }
  });
});
