import { describe, it, expect, vi } from "vitest";
import {
  GROUP_PAGE_SPACING_MS,
  GROUP_WALK_MAX_AGE_MS,
  GroupService,
  MAX_GROUP_PAGES,
  MAX_TOTAL_GROUP_PAGES,
} from "./GroupService.js";
import { DEFAULT_FB_RECIPE, type SessionTokens } from "@nashir/shared";
import type { HttpPort, StoragePort, LoggerPort } from "./ports/index.js";

const tokens: SessionTokens = {
  fb_dtsg: "d",
  jazoest: "2",
  lsd: "l",
  user: "1",
  av: "1",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "1",
  scrapedAt: 0,
};
const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

/** A joined-groups connection response, matching FB's edges + page_info shape. */
function conn(groups: { id: string; name: string }[], endCursor: string | null, hasNext: boolean): string {
  return JSON.stringify({
    data: {
      node: {
        all_joined_groups: {
          edges: groups.map((g) => ({ node: { __typename: "Group", id: g.id, name: g.name } })),
          page_info: { end_cursor: endCursor, has_next_page: hasNext },
        },
      },
    },
  });
}

function queuedHttp(bodies: string[]): HttpPort {
  let i = 0;
  return { fetch: async () => new Response(bodies[i++] ?? "{}", { status: 200 }) };
}

/** Records the pacing the service asks for without any test actually waiting for it. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => void waits.push(ms),
    waits,
  };
}

const noSleep = async (): Promise<void> => {};

describe("GroupService.loadJoinedGroups pagination", () => {
  it("follows the cursor across pages, dedupes, and caches all groups", async () => {
    const bodies = [
      conn([{ id: "111111", name: "A" }, { id: "222222", name: "B" }], "c1", true), // root
      conn([{ id: "333333", name: "C" }, { id: "222222", name: "B" }], "c2", true), // page (B dup)
      conn([{ id: "444444", name: "D" }], null, false), // last page
    ];
    const storage = memStorage();
    const gs = new GroupService(storage, queuedHttp(bodies), noopLogger, noSleep);

    const groups = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(groups.map((g) => g.id).sort()).toEqual(["111111", "222222", "333333", "444444"]);
    // Cached for later runs.
    expect((await gs.getGroups("acc1")).map((g) => g.id).sort()).toEqual([
      "111111",
      "222222",
      "333333",
      "444444",
    ]);
  });

  it("stops at the first page when there is no next page", async () => {
    const bodies = [conn([{ id: "999999", name: "Solo" }], null, false)];
    const gs = new GroupService(memStorage(), queuedHttp(bodies), noopLogger, noSleep);
    const groups = await gs.loadJoinedGroups("acc2", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    expect(groups).toHaveLength(1);
  });
});

describe("GroupService cache", () => {
  it("records when the groups were fetched", async () => {
    const gs = new GroupService(
      memStorage(),
      queuedHttp([conn([{ id: "111111", name: "A" }], null, false)]),
      noopLogger,
      noSleep,
    );
    const before = Date.now();
    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    const cache = await gs.getCache("acc1");
    expect(cache.groups).toHaveLength(1);
    expect(cache.syncedAt).toBeGreaterThanOrEqual(before);
  });

  it("treats a cache written before syncedAt existed as never synced", async () => {
    const storage = memStorage();
    // The old on-disk shape: a bare array under the same key.
    await storage.set("nashir:groups:legacy", [{ id: "111111", name: "A" }]);
    const gs = new GroupService(storage, queuedHttp([]), noopLogger, noSleep);

    const cache = await gs.getCache("legacy");
    expect(cache.groups).toHaveLength(1);
    expect(cache.syncedAt).toBe(0);
    expect(await gs.isStale("legacy", Date.now())).toBe(true);
  });

  it("reports a freshly synced cache as fresh and an aged one as stale", async () => {
    const storage = memStorage();
    const now = 1_000_000_000_000;
    await storage.set("nashir:groups:acc1", {
      accountId: "acc1",
      groups: [{ id: "111111", name: "A" }],
      syncedAt: now,
    });
    const gs = new GroupService(storage, queuedHttp([]), noopLogger, noSleep);

    expect(await gs.isStale("acc1", now + 60_000)).toBe(false);
    expect(await gs.isStale("acc1", now + 7 * 60 * 60 * 1000)).toBe(true);
  });

  it("keeps the previous cache when a load comes back empty", async () => {
    const storage = memStorage();
    const gs = new GroupService(
      storage,
      queuedHttp([
        conn([{ id: "111111", name: "A" }], null, false),
        // Second load: FB rotated a doc_id, so nothing parses out.
        JSON.stringify({ data: {} }),
      ]),
      noopLogger,
      noSleep,
    );

    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    const second = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(second.map((g) => g.id)).toEqual(["111111"]);
    expect((await gs.getCache("acc1")).groups).toHaveLength(1);
  });
});

describe("GroupService pagination is bounded and paced", () => {
  /** `count` pages that each report another one behind them. */
  const endless = (count: number): string[] =>
    Array.from({ length: count }, (_, i) =>
      conn(
        Array.from({ length: 10 }, (_, j) => ({
          id: String(1_000_000 + i * 10 + j),
          name: "g" + i + "-" + j,
        })),
        "cursor" + i,
        true,
      ),
    );

  it("waits between pages instead of firing them back to back", async () => {
    const { sleep, waits } = recordingSleep();
    const bodies = [
      conn([{ id: "111111", name: "A" }], "c1", true),
      conn([{ id: "222222", name: "B" }], "c2", true),
      conn([{ id: "333333", name: "C" }], null, false),
    ];
    const gs = new GroupService(memStorage(), queuedHttp(bodies), noopLogger, sleep);

    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    // One wait per page beyond the first; the root query is not delayed.
    expect(waits).toEqual([GROUP_PAGE_SPACING_MS, GROUP_PAGE_SPACING_MS]);
  });

  it("stops after the page cap even when Facebook keeps offering more", async () => {
    const { sleep, waits } = recordingSleep();
    const http = queuedHttp(endless(40));
    const fetchSpy = vi.spyOn(http, "fetch");
    const gs = new GroupService(memStorage(), http, noopLogger, sleep);

    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    // The root query plus at most MAX_GROUP_PAGES follow-ups — not the 26 that
    // earned the block.
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_GROUP_PAGES + 1);
    expect(waits).toHaveLength(MAX_GROUP_PAGES);
  });

  it("keeps walking while each page still adds groups, however large the list already is", async () => {
    // This used to stop on a "diminishing return": a page adding under 10% of what was
    // already held. A full page of 100 is under 10% of anything past 1000, so every
    // large account was cut off — the bug a user with 900+ groups reported.
    const { sleep } = recordingSleep();
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(200_000 + i), name: "g" + i }));
    const bodies = [
      conn(many, "c1", true),
      conn([...many, { id: "999999", name: "new" }], "c2", true),
      conn([{ id: "888888", name: "last" }], null, false),
    ];
    const http = queuedHttp(bodies);
    const fetchSpy = vi.spyOn(http, "fetch");
    const gs = new GroupService(memStorage(), http, noopLogger, sleep);

    const groups = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(groups.some((g) => g.id === "888888")).toBe(true);
  });

  it("still abandons a cursor that returns nothing new", async () => {
    const one = [{ id: "111111", name: "A" }];
    const bodies = [conn(one, "c1", true), conn(one, "c2", true), conn([{ id: "222222", name: "B" }], null, false)];
    const http = queuedHttp(bodies);
    const fetchSpy = vi.spyOn(http, "fetch");
    const gs = new GroupService(memStorage(), http, noopLogger, noSleep);

    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await gs.hasPendingWalk("acc1", Date.now())).toBe(false);
  });
});

describe("GroupService walks a long list in resumable batches", () => {
  /** An account of `total` groups: a root page of `first`, then pages of `per`. */
  function account(total: number, first: number, per: number): string[] {
    const ids = Array.from({ length: total }, (_, i) => String(100_000 + i));
    const pages: string[][] = [ids.slice(0, first)];
    for (let i = first; i < total; i += per) pages.push(ids.slice(i, i + per));
    return pages.map((p, i) =>
      conn(
        p.map((id) => ({ id, name: "G" + id })),
        i < pages.length - 1 ? "cur" + i : null,
        i < pages.length - 1,
      ),
    );
  }

  /** Serves `bodies` by cursor, so a resumed walk gets the page its cursor points at. */
  function cursorHttp(bodies: string[]): HttpPort & { cursors: (string | undefined)[] } {
    const cursors: (string | undefined)[] = [];
    return {
      cursors,
      fetch: async (_url, init) => {
        const vars = JSON.parse(new URLSearchParams(String(init?.body)).get("variables") ?? "{}");
        cursors.push(vars.cursor);
        const idx = vars.cursor ? Number(String(vars.cursor).slice(3)) + 1 : 0;
        return new Response(bodies[idx] ?? "{}", { status: 200 });
      },
    };
  }

  const ids = (gs: { id: string }[]) => gs.map((g) => g.id);

  it("loads a list longer than one batch by resuming from the saved cursor", async () => {
    const storage = memStorage();
    const http = cursorHttp(account(950, 10, 100));
    const gs = new GroupService(storage, http, noopLogger, noSleep);

    const first = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    expect(first).toHaveLength(910);
    expect(await gs.hasPendingWalk("acc1", Date.now())).toBe(true);

    http.cursors.length = 0;
    const second = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(second).toHaveLength(950);
    expect(new Set(ids(second)).size).toBe(950);
    // Picked up where the first batch stopped — no second trip through the root query.
    expect(http.cursors[0]).toBe("cur9");
    expect(await gs.hasPendingWalk("acc1", Date.now())).toBe(false);
  });

  it("keeps the previous list visible while a fresh walk is still partial, then drops what is gone", async () => {
    const storage = memStorage();
    await storage.set("nashir:groups:acc1", {
      accountId: "acc1",
      groups: [{ id: "999999", name: "left long ago" }],
      syncedAt: 1,
    });
    const gs = new GroupService(storage, cursorHttp(account(950, 10, 100)), noopLogger, noSleep);

    const partial = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    expect(ids(partial)).toContain("999999");

    const done = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    expect(ids(done)).not.toContain("999999");
    expect(done).toHaveLength(950);
  });

  it("treats a cache written before walks existed as complete", async () => {
    const storage = memStorage();
    await storage.set("nashir:groups:acc1", { accountId: "acc1", groups: [{ id: "1", name: "A" }], syncedAt: 1 });
    const gs = new GroupService(storage, queuedHttp([]), noopLogger, noSleep);

    expect(await gs.hasPendingWalk("acc1", Date.now())).toBe(false);
  });

  it("restarts from page one when the saved cursor is too old to trust", async () => {
    const storage = memStorage();
    const http = cursorHttp(account(950, 10, 100));
    const gs = new GroupService(storage, http, noopLogger, noSleep);
    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
    const cache = await gs.getCache("acc1");
    await storage.set("nashir:groups:acc1", {
      ...cache,
      walk: { ...cache.walk!, startedAt: Date.now() - GROUP_WALK_MAX_AGE_MS - 1 },
    });

    expect(await gs.hasPendingWalk("acc1", Date.now())).toBe(false);
    http.cursors.length = 0;
    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(http.cursors[0]).toBeUndefined();
  });

  it("abandons a dead cursor instead of retrying it forever", async () => {
    const storage = memStorage();
    const bodies = account(950, 10, 100);
    const gs = new GroupService(storage, cursorHttp(bodies), noopLogger, noSleep);
    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    // The session moved on and the cursor now errors.
    const dead = new GroupService(
      storage,
      { fetch: async () => new Response(JSON.stringify({ errors: [{ message: "bad cursor" }] })) },
      noopLogger,
      noSleep,
    );
    const groups = await dead.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(groups).toHaveLength(910);
    expect(await dead.hasPendingWalk("acc1", Date.now())).toBe(false);
  });

  it("saves the cursor when the governor refuses mid-walk, so the next batch starts there", async () => {
    const storage = memStorage();
    const bodies = account(950, 10, 100);
    let served = 0;
    const refusing: HttpPort = {
      fetch: async (url, init) => {
        if (served++ >= 3) throw new Error("Facebook asked us to pause.");
        return cursorHttp(bodies).fetch(url, init);
      },
    };
    const gs = new GroupService(storage, refusing, noopLogger, noSleep);
    await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    const http = cursorHttp(bodies);
    const resumed = new GroupService(storage, http, noopLogger, noSleep);
    const all = await resumed.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(http.cursors[0]).toBe("cur2");
    expect(all).toHaveLength(950);
  });

  it("stops the whole walk at the total page cap even if Facebook never says it is done", async () => {
    const storage = memStorage();
    const bodies = account(100_000, 10, 100);
    const http = cursorHttp(bodies);
    const gs = new GroupService(storage, http, noopLogger, noSleep);

    let batches = 0;
    do {
      await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });
      batches++;
    } while ((await gs.hasPendingWalk("acc1", Date.now())) && batches < 50);

    expect(http.cursors).toHaveLength(MAX_TOTAL_GROUP_PAGES);
  });
});

describe("GroupService staleness cannot get stuck", () => {
  it("stamps syncedAt even when a refresh comes back empty", async () => {
    const storage = memStorage();
    const now = 1_000_000_000_000;
    await storage.set("nashir:groups:acc1", {
      accountId: "acc1",
      groups: [{ id: "111111", name: "A" }],
      syncedAt: now - 7 * 60 * 60 * 1000,
    });
    // A rotated doc_id: the walk succeeds but yields nothing.
    const gs = new GroupService(storage, queuedHttp(["{}"]), noopLogger, noSleep);

    const groups = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect(groups).toHaveLength(1);
    // Without the stamp this cache stays stale forever and every service worker wake
    // re-runs the whole paginated walk.
    expect(await gs.isStale("acc1", Date.now())).toBe(false);
  });

  it("treats a legitimately empty account as synced, not as permanently stale", async () => {
    const gs = new GroupService(memStorage(), queuedHttp(["{}"]), noopLogger, noSleep);

    await gs.loadJoinedGroups("empty", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    expect((await gs.getCache("empty")).groups).toHaveLength(0);
    expect(await gs.isStale("empty", Date.now())).toBe(false);
  });
});

describe("GroupService keeps what it has already fetched", () => {
  /** An HttpPort that serves N pages and then refuses, as the governor would. */
  function refusingAfter(bodies: string[], n: number): HttpPort {
    let i = 0;
    return {
      fetch: async () => {
        if (i >= n) throw new Error("Facebook asked us to pause.");
        return new Response(bodies[i++] ?? "{}", { status: 200 });
      },
    };
  }

  it("returns and caches the pages it got when a later one is refused", async () => {
    const storage = memStorage();
    const bodies = [
      conn([{ id: "111111", name: "A" }], "c1", true),
      conn([{ id: "222222", name: "B" }], "c2", true),
      conn([{ id: "333333", name: "C" }], "c3", true),
    ];
    const gs = new GroupService(storage, refusingAfter(bodies, 2), noopLogger, noSleep);

    const groups = await gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true });

    // Two pages landed before the refusal; throwing them away would mean spending calls on
    // them again next time to reach the same place.
    expect(groups.map((g) => g.id).sort()).toEqual(["111111", "222222"]);
    expect((await gs.getGroups("acc1")).map((g) => g.id).sort()).toEqual(["111111", "222222"]);
  });

  it("propagates the refusal when there is nothing to salvage", async () => {
    const gs = new GroupService(memStorage(), refusingAfter([], 0), noopLogger, noSleep);

    await expect(
      gs.loadJoinedGroups("acc1", tokens, DEFAULT_FB_RECIPE, { refresh: true }),
    ).rejects.toThrow(/pause/i);
  });
});
