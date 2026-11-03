import type { SessionTokens } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { TokenScraper } from "./TokenScraper.js";
import { VERIFIED_KEY, type VerifiedMap } from "./verification.js";
import type { CookiePort, CookieRecord, LoggerPort, StoragePort, TabPort } from "./ports/index.js";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const fakeHash = async (v: string) => `h(${v})`;

function tokens(user: string): SessionTokens {
  return { fb_dtsg: "dtsg-long-enough", user } as SessionTokens;
}

function harness(opts: {
  /** Cookies the browser holds; mutate through `jar` to model a swap. */
  jar?: Record<string, string>;
  scraped?: SessionTokens | null;
  openTab?: boolean;
  storageThrows?: boolean;
}) {
  const jar: Record<string, string> = opts.jar ?? { c_user: "u1", xs: "xs-1" };
  const map = new Map<string, unknown>();
  let sets = 0;
  let now = T0;

  const storage: StoragePort = {
    async get<T>(k: string) {
      if (opts.storageThrows) throw new Error("storage down");
      return (map.get(k) as T) ?? null;
    },
    async set(k, v) {
      sets++;
      map.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k) {
      map.delete(k);
    },
  };
  const cookies: CookiePort = {
    async get(_url, name) {
      return jar[name] ? ({ name, value: jar[name] } as CookieRecord) : null;
    },
    async getAll() {
      return [];
    },
    async set() {},
    async remove() {},
  };
  const tab: TabPort = {
    async ensureFacebookTab() {
      return 1;
    },
    async findFacebookTab() {
      return opts.openTab === false ? null : 1;
    },
    async reloadAndWait() {},
    async callContent<T>() {
      const data = opts.scraped === undefined ? tokens(jar.c_user ?? "") : opts.scraped;
      return data ? { ok: true, data: data as T } : { ok: false, error: "nope" };
    },
  };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scraper = new TokenScraper(
    tab,
    logger,
    undefined,
    storage,
    cookies,
    { now: () => now },
    fakeHash,
  );
  return {
    scraper,
    jar,
    logger,
    verified: () => map.get(VERIFIED_KEY) as VerifiedMap | undefined,
    sets: () => sets,
    advance: (ms: number) => (now += ms),
  };
}

describe("marking a session verified", () => {
  it("scrapeCurrent records the c_user with a hash of xs", async () => {
    const h = harness({});
    await h.scraper.scrapeCurrent();
    expect(h.verified()).toEqual({ u1: { at: T0, xs: "h(xs-1)" } });
  });

  it("scrapeFromOpenTab records it too", async () => {
    const h = harness({});
    await h.scraper.scrapeFromOpenTab();
    expect(h.verified()?.u1?.at).toBe(T0);
  });

  it("scrapeAfterSwap records it for the account now in the jar", async () => {
    const h = harness({ jar: { c_user: "managed", xs: "xs-m" } });
    await h.scraper.scrapeAfterSwap();
    expect(h.verified()).toEqual({ managed: { at: T0, xs: "h(xs-m)" } });
  });

  it("a managed-account scrape does not overwrite the current session's entry", async () => {
    const h = harness({});
    await h.scraper.scrapeCurrent();
    h.jar.c_user = "managed";
    h.jar.xs = "xs-m";
    h.advance(MIN);
    await h.scraper.scrapeAfterSwap();
    expect(h.verified()).toEqual({
      u1: { at: T0, xs: "h(xs-1)" },
      managed: { at: T0 + MIN, xs: "h(xs-m)" },
    });
  });

  it("writes once for consecutive scrapes within five minutes", async () => {
    const h = harness({});
    await h.scraper.scrapeCurrent();
    h.advance(MIN);
    await h.scraper.scrapeFromOpenTab();
    h.advance(MIN);
    await h.scraper.scrapeFromOpenTab();
    expect(h.sets()).toBe(1);
  });

  it("does not mark when the scraped user is not the c_user cookie's", async () => {
    // A cookie swap can land between the scrape and the cookie read.
    const h = harness({ scraped: tokens("someone-else") });
    await h.scraper.scrapeCurrent();
    expect(h.verified()).toBeUndefined();
  });

  it("does not mark when there is no xs cookie", async () => {
    const h = harness({ jar: { c_user: "u1" } });
    await h.scraper.scrapeCurrent();
    expect(h.verified()).toBeUndefined();
  });

  it("does not mark a failed scrape", async () => {
    const h = harness({ scraped: null });
    await expect(h.scraper.scrapeCurrent()).rejects.toThrow();
    expect(await h.scraper.scrapeFromOpenTab()).toBeNull();
    expect(h.verified()).toBeUndefined();
  });

  it("does not mark tokens that fail validation", async () => {
    const h = harness({ scraped: { fb_dtsg: "x", user: "u1" } as SessionTokens });
    await expect(h.scraper.scrapeCurrent()).rejects.toThrow();
    expect(h.verified()).toBeUndefined();
  });

  it("a storage failure never fails the scrape", async () => {
    const h = harness({ storageThrows: true });
    await expect(h.scraper.scrapeCurrent()).resolves.toMatchObject({ user: "u1" });
    expect(h.logger.warn).toHaveBeenCalled();
  });
});

describe("without the optional ports", () => {
  it("scrapes exactly as before", async () => {
    const h = harness({});
    const bare = new TokenScraper(
      {
        async ensureFacebookTab() {
          return 1;
        },
        async findFacebookTab() {
          return 1;
        },
        async reloadAndWait() {},
        async callContent<T>() {
          return { ok: true, data: tokens("u1") as T };
        },
      },
      h.logger,
    );
    await expect(bare.scrapeCurrent()).resolves.toMatchObject({ user: "u1" });
    expect(h.verified()).toBeUndefined();
  });
});
