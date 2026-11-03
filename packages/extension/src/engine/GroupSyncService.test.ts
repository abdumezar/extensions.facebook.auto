import { afterEach, describe, it, expect, vi } from "vitest";
import { CURRENT_SESSION, DEFAULT_FB_RECIPE, type Group, type SessionTokens } from "@nashir/shared";
import { GroupSyncService } from "./GroupSyncService.js";
import { GROUP_RESUME_DELAY_MS } from "./GroupService.js";
import type { GroupService } from "./GroupService.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { LoggerPort, StoragePort } from "./ports/index.js";

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

const tokens: SessionTokens = {
  fb_dtsg: "dtsg-token",
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

const GROUPS: Group[] = [{ id: "111111", name: "A" }];

/** A GroupService stand-in whose staleness and load behaviour each test dictates. */
function fakeGroups(opts: { stale: boolean; groups?: Group[]; syncedAt?: number; pending?: () => boolean }) {
  const load = vi.fn(async () => opts.groups ?? GROUPS);
  return {
    service: {
      isStale: async () => opts.stale,
      hasPendingWalk: async () => opts.pending?.() ?? false,
      getCache: async (accountId: string) => ({
        accountId,
        groups: opts.groups ?? GROUPS,
        syncedAt: opts.syncedAt ?? 0,
      }),
      loadJoinedGroups: load,
    } as unknown as GroupService,
    load,
  };
}

function fakeScraper(fromOpenTab: SessionTokens | null) {
  const scrapeFromOpenTab = vi.fn(async () => fromOpenTab);
  const scrapeCurrent = vi.fn(async () => tokens);
  const scrapeAfterSwap = vi.fn(async () => tokens);
  return {
    scraper: { scrapeFromOpenTab, scrapeCurrent, scrapeAfterSwap } as unknown as TokenScraper,
    scrapeFromOpenTab,
    scrapeCurrent,
    scrapeAfterSwap,
  };
}

function fakeAccounts() {
  const withAccount = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
  return { accounts: { withAccount } as unknown as CookieAccountManager, withAccount };
}

const recipe = async () => DEFAULT_FB_RECIPE;

describe("GroupSyncService.syncIfStale", () => {
  it("does nothing when the cache is still fresh", async () => {
    const g = fakeGroups({ stale: false });
    const s = fakeScraper(tokens);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    await sync.syncIfStale();

    expect(s.scrapeFromOpenTab).not.toHaveBeenCalled();
    expect(g.load).not.toHaveBeenCalled();
  });

  it("skips silently when no logged-in Facebook tab is open", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(null);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    const cache = await sync.syncIfStale();

    expect(g.load).not.toHaveBeenCalled();
    // The caller still gets whatever was cached before.
    expect(cache?.groups).toEqual(GROUPS);
  });

  it("loads and caches once tokens are free to obtain", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    await sync.syncIfStale();

    expect(g.load).toHaveBeenCalledWith(CURRENT_SESSION, tokens, DEFAULT_FB_RECIPE, { refresh: true });
  });

  it("never opens a tab and never swaps cookies", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);
    const a = fakeAccounts();
    const sync = new GroupSyncService(g.service, s.scraper, a.accounts, recipe, noopLogger, memStorage());

    await sync.syncIfStale();

    expect(s.scrapeCurrent).not.toHaveBeenCalled();
    expect(a.withAccount).not.toHaveBeenCalled();
  });

  it("refuses to auto-sync a managed account, since that would swap cookies", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);
    const a = fakeAccounts();
    const sync = new GroupSyncService(g.service, s.scraper, a.accounts, recipe, noopLogger, memStorage());

    await sync.syncIfStale("acc_123");

    expect(g.load).not.toHaveBeenCalled();
    expect(a.withAccount).not.toHaveBeenCalled();
  });

  it("throttles repeat attempts so a failing sync cannot retry on every page load", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    await sync.syncIfStale();
    await sync.syncIfStale();
    await sync.syncIfStale();

    expect(g.load).toHaveBeenCalledTimes(1);
  });

  it("survives a load that throws", async () => {
    const g = fakeGroups({ stale: true });
    (g.service.loadJoinedGroups as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("doc_id rotated"),
    );
    const s = fakeScraper(tokens);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    await expect(sync.syncIfStale()).resolves.toBeTruthy();
  });
});

describe("GroupSyncService.load", () => {
  it("scrapes the live session without a cookie swap for the current session", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(null);
    const a = fakeAccounts();
    const sync = new GroupSyncService(g.service, s.scraper, a.accounts, recipe, noopLogger, memStorage());

    await sync.load(CURRENT_SESSION, true);

    expect(s.scrapeCurrent).toHaveBeenCalled();
    expect(a.withAccount).not.toHaveBeenCalled();
  });

  it("swaps to a managed account and scrapes after the swap", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(null);
    const a = fakeAccounts();
    const sync = new GroupSyncService(g.service, s.scraper, a.accounts, recipe, noopLogger, memStorage());

    await sync.load("acc_123", true);

    expect(a.withAccount).toHaveBeenCalled();
    expect(s.scrapeAfterSwap).toHaveBeenCalled();
    expect(s.scrapeCurrent).not.toHaveBeenCalled();
  });

  it("collapses concurrent loads for the same account into one fetch", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(null);
    const sync = new GroupSyncService(g.service, s.scraper, fakeAccounts().accounts, recipe, noopLogger, memStorage());

    await Promise.all([sync.load(CURRENT_SESSION, true), sync.load(CURRENT_SESSION, true)]);

    expect(g.load).toHaveBeenCalledTimes(1);
  });
});

describe("GroupSyncService retry floor survives service worker eviction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The bug this whole feature exists to fix. The floor used to live in an in-memory
   * Map, and MV3 evicts the service worker after ~30 seconds idle, so every
   * facebook.com page load woke a fresh service worker with an empty Map and the floor never
   * applied. Two instances over one storage is that eviction, in a test.
   */
  it("holds across a brand-new service worker generation", async () => {
    const storage = memStorage();
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);

    const first = new GroupSyncService(
      g.service,
      s.scraper,
      fakeAccounts().accounts,
      recipe,
      noopLogger,
      storage,
    );
    await first.syncIfStale();
    expect(g.load).toHaveBeenCalledTimes(1);

    // The service worker dies. Everything in memory goes with it; storage does not.
    const second = new GroupSyncService(
      g.service,
      s.scraper,
      fakeAccounts().accounts,
      recipe,
      noopLogger,
      storage,
    );
    await second.syncIfStale();
    await second.syncIfStale();

    expect(g.load).toHaveBeenCalledTimes(1);
  });

  it("backs off far harder after a failure than after a success", async () => {
    vi.useFakeTimers();
    const storage = memStorage();
    const g = fakeGroups({ stale: true });
    g.load.mockRejectedValueOnce(new Error("rotated doc_id"));
    const s = fakeScraper(tokens);
    const make = () =>
      new GroupSyncService(
        g.service,
        s.scraper,
        fakeAccounts().accounts,
        recipe,
        noopLogger,
        storage,
      );

    await make().syncIfStale();
    expect(g.load).toHaveBeenCalledTimes(1);

    // 10 minutes later: past the 5-minute success floor, well inside the 30-minute
    // failure floor. A sync that failed once will fail again; spending the call budget
    // to re-learn that is exactly what filled Facebook's counter.
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await make().syncIfStale();
    expect(g.load).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 25 * 60 * 1000);
    await make().syncIfStale();
    expect(g.load).toHaveBeenCalledTimes(2);
  });

  it("stands aside while a campaign is running", async () => {
    const g = fakeGroups({ stale: true });
    const s = fakeScraper(tokens);
    const sync = new GroupSyncService(
      g.service,
      s.scraper,
      fakeAccounts().accounts,
      recipe,
      noopLogger,
      memStorage(),
      async () => true,
    );

    await sync.syncIfStale();

    expect(s.scrapeFromOpenTab).not.toHaveBeenCalled();
    expect(g.load).not.toHaveBeenCalled();
  });
});

describe("GroupSyncService finishes a walk that took more than one batch", () => {
  const build = (g: ReturnType<typeof fakeGroups>, storage = memStorage(), tab: SessionTokens | null = tokens) => {
    const scheduled: number[] = [];
    const sync = new GroupSyncService(
      g.service,
      fakeScraper(tab).scraper,
      fakeAccounts().accounts,
      recipe,
      noopLogger,
      storage,
      async () => false,
      async (at) => void scheduled.push(at),
    );
    return { sync, scheduled };
  };

  it("continues an unfinished walk even though the cache is fresh", async () => {
    const g = fakeGroups({ stale: false, pending: () => true });
    const { sync } = build(g);

    await sync.syncIfStale();

    expect(g.load).toHaveBeenCalledWith(CURRENT_SESSION, tokens, DEFAULT_FB_RECIPE, { refresh: true });
  });

  it("schedules the next batch while the walk is unfinished", async () => {
    const g = fakeGroups({ stale: true, pending: () => true });
    const { sync, scheduled } = build(g);
    const before = Date.now();

    await sync.syncIfStale();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeGreaterThanOrEqual(before + GROUP_RESUME_DELAY_MS);
  });

  it("schedules nothing once the walk is complete", async () => {
    const g = fakeGroups({ stale: true });
    const { sync, scheduled } = build(g);

    await sync.syncIfStale();

    expect(scheduled).toHaveLength(0);
  });

  it("resumes after the batch gap rather than the five-minute floor", async () => {
    const storage = memStorage();
    await storage.set(`nashir:groupsync:attempt:${CURRENT_SESSION}`, {
      at: Date.now() - GROUP_RESUME_DELAY_MS - 1000,
      ok: true,
    });
    const g = fakeGroups({ stale: false, pending: () => true });
    const { sync } = build(g, storage);

    await sync.syncIfStale();

    expect(g.load).toHaveBeenCalled();
  });

  it("keeps the continuation alive when no Facebook tab is open yet", async () => {
    const g = fakeGroups({ stale: false, pending: () => true });
    const { sync, scheduled } = build(g, memStorage(), null);

    await sync.syncIfStale();

    expect(g.load).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it("schedules a continuation after a user-initiated load of the current session", async () => {
    const g = fakeGroups({ stale: false, pending: () => true });
    const { sync, scheduled } = build(g);

    await sync.load(CURRENT_SESSION, true);

    expect(scheduled).toHaveLength(1);
  });

  it("never schedules a background continuation for a managed account", async () => {
    const g = fakeGroups({ stale: false, pending: () => true });
    const { sync, scheduled } = build(g);

    await sync.load("managed-1", true);

    expect(scheduled).toHaveLength(0);
  });
});
