import { DEFAULT_FB_RECIPE, UiRequestSchema, bundledDocIds, type FbRecipe } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { DocIdStore } from "./DocIdStore.js";
import type { LoggerPort, StoragePort } from "./ports/index.js";

const REACTIONS = "CometUFIReactionsDialogTabContentRefetchQuery";
const REACTIONS_FIRST = "CometUFIReactionsDialogQuery";
const NOW = 1_700_000_000_000;

// The router reaches the container only through this seam; the container itself needs chrome.
const stub = vi.hoisted(() => ({ store: null as null | { list(): Promise<unknown> } }));
vi.mock("../background/container.js", () => ({ container: () => ({ docIds: stub.store }) }));

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

function logger(): LoggerPort {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const bundled = bundledDocIds(DEFAULT_FB_RECIPE);

describe("DocIdStore", () => {
  it("stores a changed id with bundledAtLearn and logs from→to", async () => {
    const { storage, map } = memory();
    const log = logger();
    const store = new DocIdStore(storage, log);

    const changes = await store.record({ [REACTIONS_FIRST]: "70000001" }, NOW);

    expect(changes).toEqual([{ name: REACTIONS_FIRST, from: bundled[REACTIONS_FIRST], to: "70000001" }]);
    const expected = {
      [REACTIONS_FIRST]: { docId: "70000001", seenAt: NOW, bundledAtLearn: bundled[REACTIONS_FIRST] },
    };
    expect(map.get("nashir:docIds")).toEqual(expected);
    expect(await store.get()).toEqual(expected);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(REACTIONS_FIRST),
      expect.objectContaining({ from: bundled[REACTIONS_FIRST], to: "70000001" }),
    );
  });

  it("deletes the override when the harvested id equals the bundled one", async () => {
    const { storage } = memory();
    const store = new DocIdStore(storage, logger());
    await store.record({ [REACTIONS]: "70000002" }, NOW);

    const changes = await store.record({ [REACTIONS]: bundled[REACTIONS]! }, NOW + 1);

    expect(changes).toEqual([{ name: REACTIONS, from: "70000002", to: bundled[REACTIONS] }]);
    expect(await store.get()).toEqual({});
  });

  it("reports nothing when the page agrees with the bundle and no override exists", async () => {
    const { storage } = memory();
    const log = logger();
    const store = new DocIdStore(storage, log);
    expect(await store.record({ [REACTIONS]: bundled[REACTIONS]! }, NOW)).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("keeps seenAt fresh without reporting a change when the same id is seen again", async () => {
    const { storage } = memory();
    const store = new DocIdStore(storage, logger());
    await store.record({ [REACTIONS]: "70000003" }, NOW);
    expect(await store.record({ [REACTIONS]: "70000003" }, NOW + 5)).toEqual([]);
    expect((await store.get())[REACTIONS]?.seenAt).toBe(NOW + 5);
  });

  it("ignores names the bundle does not know", async () => {
    const { storage, map } = memory();
    const store = new DocIdStore(storage, logger());
    expect(await store.record({ NotAnOperation: "70000004" }, NOW)).toEqual([]);
    expect(map.has("nashir:docIds")).toBe(false);
  });

  it("get drops overrides learned against an older bundle", async () => {
    const { storage, map } = memory();
    map.set("nashir:docIds", {
      [REACTIONS]: { docId: "70000005", seenAt: NOW, bundledAtLearn: "11111" },
      [REACTIONS_FIRST]: { docId: "70000006", seenAt: NOW, bundledAtLearn: bundled[REACTIONS_FIRST] },
    });
    const store = new DocIdStore(storage, logger());
    expect(Object.keys(await store.get())).toEqual([REACTIONS_FIRST]);
  });

  it("get survives a corrupt stored value", async () => {
    const { storage, map } = memory();
    map.set("nashir:docIds", ["nope"]);
    expect(await new DocIdStore(storage, logger()).get()).toEqual({});
  });

  it("lists every operation with its source", async () => {
    const { storage } = memory();
    const store = new DocIdStore(storage, logger());
    await store.record({ [REACTIONS_FIRST]: "70000007" }, NOW);

    const rows = await store.list();

    expect(rows).toHaveLength(Object.keys(bundled).length);
    expect(rows.find((r) => r.name === REACTIONS_FIRST)).toEqual({
      name: REACTIONS_FIRST,
      active: "70000007",
      source: "learned",
      seenAt: NOW,
    });
    expect(rows.find((r) => r.name === REACTIONS)).toEqual({
      name: REACTIONS,
      active: bundled[REACTIONS],
      source: "bundled",
    });
  });

  it("works against an injected bundle", async () => {
    const recipe = { a: { docId: "10001", friendlyName: "Alpha" } } as unknown as FbRecipe;
    const { storage } = memory();
    const store = new DocIdStore(storage, logger(), recipe);
    await store.record({ Alpha: "20002" }, NOW);
    expect(await store.list()).toEqual([{ name: "Alpha", active: "20002", source: "learned", seenAt: NOW }]);
  });
});

describe("GET_DOC_IDS", () => {
  it("is routed to the store and answers with one row per operation", async () => {
    const { handleUiRequest } = await import("../background/messageRouter.js");
    const { storage } = memory();
    const store = new DocIdStore(storage, logger());
    stub.store = store;
    await store.record({ [REACTIONS_FIRST]: "70000008" }, NOW);

    expect(UiRequestSchema.safeParse({ type: "GET_DOC_IDS" }).success).toBe(true);
    const res = await handleUiRequest({ type: "GET_DOC_IDS" });

    expect(res.ok).toBe(true);
    const rows = res.data as Array<{ name: string; active: string; source: string; seenAt?: number }>;
    expect(rows).toHaveLength(Object.keys(bundled).length);
    expect(rows.find((r) => r.name === REACTIONS_FIRST)).toMatchObject({ active: "70000008", source: "learned" });
    expect(rows.filter((r) => r.source === "bundled")).toHaveLength(rows.length - 1);
  });
});
