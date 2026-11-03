import type { FbProfile } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { SESSION_PROFILE_KEY, SessionProbe } from "./SessionProbe.js";
import type { TokenScraper } from "./TokenScraper.js";
import { VERIFIED_KEY } from "./verification.js";
import type { CookiePort, CookieRecord, LoggerPort, StoragePort, TabPort } from "./ports/index.js";

const USER = "100000000000001";
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const fakeHash = async (v: string) => `h(${v})`;
const PROFILE: FbProfile = {
  fbUserId: USER,
  name: "ليلى حداد",
  avatarUrl: "https://scontent.example/avatar.jpg",
  profileUrl: "https://www.facebook.com/layla.haddad",
};

function harness(opts: {
  loggedInAs?: string | null;
  openTab?: boolean;
  /** What SCRAPE_PROFILE answers, or null for "content script gave us nothing". */
  liveProfile?: FbProfile | null;
  tokens?: boolean;
  cached?: FbProfile;
  scrapeThrows?: boolean;
  /** The xs cookie the browser holds; null for none. */
  xs?: string | null;
  /** A stored live-check entry, by user id. */
  verified?: Record<string, { at: number; xs: string }>;
  now?: number;
}) {
  const map = new Map<string, unknown>();
  if (opts.cached) map.set(SESSION_PROFILE_KEY, opts.cached);
  if (opts.verified) map.set(VERIFIED_KEY, opts.verified);

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

  const cookies: CookiePort = {
    async get(_url, name) {
      const value = opts.loggedInAs === undefined ? USER : opts.loggedInAs;
      if (name === "xs") {
        const xs = opts.xs === undefined ? "xs-1" : opts.xs;
        return xs ? ({ name, value: xs } as CookieRecord) : null;
      }
      return name === "c_user" && value ? ({ name, value } as CookieRecord) : null;
    },
    async getAll() {
      return [];
    },
    async set() {},
    async remove() {},
  };

  let opened = 0;
  const tab: TabPort = {
    async ensureFacebookTab() {
      opened++;
      return 1;
    },
    async findFacebookTab() {
      return opts.openTab ? 1 : null;
    },
    async reloadAndWait() {},
    async callContent<T>() {
      const p = opts.liveProfile === undefined ? PROFILE : opts.liveProfile;
      return p ? { ok: true, data: p as T } : { ok: false, error: "no content script" };
    },
  };

  const scraper = {
    async scrapeFromOpenTab() {
      if (opts.scrapeThrows) throw new Error("token scrape failed");
      return opts.tokens === false ? null : ({ fb_dtsg: "d" } as never);
    },
    async scrapeCurrent() {
      if (opts.scrapeThrows) throw new Error("token scrape failed");
      return opts.tokens === false ? null : ({ fb_dtsg: "d" } as never);
    },
  } as unknown as TokenScraper;

  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    probe: new SessionProbe(cookies, tab, scraper, logger, storage, { now: () => opts.now ?? T0 }, fakeHash),
    storage,
    map,
    openedTabs: () => opened,
  };
}

describe("status — logged out", () => {
  it("reports it plainly", async () => {
    const { probe } = harness({ loggedInAs: null });
    expect(await probe.status()).toMatchObject({ loggedIn: false, tokensReady: false });
  });
});

describe("status — no Facebook tab open (the cold-open case)", () => {
  it("used to give a bare id; now gives back the remembered person", async () => {
    const { probe } = harness({ openTab: false, cached: PROFILE });
    const s = await probe.status();
    expect(s.profile?.name).toBe("ليلى حداد");
    expect(s.profile?.avatarUrl).toBe(PROFILE.avatarUrl);
  });

  it("marks that identity as remembered, not live", async () => {
    // Presenting it as live would keep naming an account the user has logged out of.
    const { probe } = harness({ openTab: false, cached: PROFILE });
    expect((await probe.status()).profileFresh).toBe(false);
  });

  it("falls back to the bare id when there is nothing remembered", async () => {
    const { probe } = harness({ openTab: false });
    const s = await probe.status();
    expect(s.profile).toEqual({ fbUserId: USER });
    expect(s.profileFresh).toBe(false);
  });

  it("never opens a tab to find out", async () => {
    const { probe, openedTabs } = harness({ openTab: false, cached: PROFILE });
    await probe.status();
    expect(openedTabs()).toBe(0);
  });

  it("refuses a cached profile belonging to a different account", async () => {
    // Logging into a second account must not keep showing the first one's face on the
    // card that says which account is about to post.
    const { probe } = harness({
      openTab: false,
      cached: { ...PROFILE, fbUserId: "999999999" },
    });
    expect((await probe.status()).profile).toEqual({ fbUserId: USER });
  });
});

describe("status — a Facebook tab is open", () => {
  it("reads the live profile and marks it fresh", async () => {
    const { probe } = harness({ openTab: true });
    const s = await probe.status();
    expect(s).toMatchObject({ loggedIn: true, tokensReady: true, profileFresh: true });
    expect(s.profile?.name).toBe("ليلى حداد");
  });

  it("remembers it for next time", async () => {
    const { probe, map } = harness({ openTab: true });
    await probe.status();
    expect(map.get(SESSION_PROFILE_KEY)).toMatchObject({ fbUserId: USER, name: "ليلى حداد" });
  });

  it("falls back to the remembered one when the live scrape comes back empty", async () => {
    const { probe } = harness({ openTab: true, liveProfile: null, cached: PROFILE });
    const s = await probe.status();
    expect(s.profile?.name).toBe("ليلى حداد");
    expect(s.profileFresh).toBe(false);
  });

  it("still answers with the remembered person when the token scrape throws", async () => {
    const { probe } = harness({ openTab: true, scrapeThrows: true, cached: PROFILE });
    const s = await probe.status();
    expect(s.tokensReady).toBe(false);
    expect(s.profile?.name).toBe("ليلى حداد");
    expect(s.error).toContain("token scrape failed");
  });
});

describe("remember", () => {
  it("never overwrites a good cache with a nameless profile", async () => {
    // A nameless profile is the thing this whole cache exists to improve on.
    const { probe, map } = harness({
      openTab: true,
      liveProfile: { fbUserId: USER },
      cached: PROFILE,
    });
    await probe.status();
    expect((map.get(SESSION_PROFILE_KEY) as FbProfile).name).toBe("ليلى حداد");
  });
});

describe("refreshProfileIfPossible", () => {
  it("updates the memory from an already-open page, opening nothing", async () => {
    const fresher = { ...PROFILE, name: "Layla", avatarUrl: "https://scontent.example/new.jpg" };
    const { probe, map, openedTabs } = harness({ openTab: true, liveProfile: fresher, cached: PROFILE });
    await probe.refreshProfileIfPossible();
    expect(map.get(SESSION_PROFILE_KEY)).toMatchObject({ name: "Layla" });
    expect(openedTabs()).toBe(0);
  });

  it("is a no-op with no open tab", async () => {
    const { probe, map } = harness({ openTab: false, cached: PROFILE });
    expect(await probe.refreshProfileIfPossible()).toBeNull();
    expect(map.get(SESSION_PROFILE_KEY)).toEqual(PROFILE);
  });
});

describe("verifiedAt — a recent live check outlives the tab that made it", () => {
  const fresh = { [USER]: { at: T0 - 5 * 60_000, xs: "h(xs-1)" } };

  it("is reported with no Facebook tab open", async () => {
    const { probe } = harness({ openTab: false, verified: fresh });
    const s = await probe.status();
    expect(s.tokensReady).toBe(false);
    expect(s.verifiedAt).toBe(T0 - 5 * 60_000);
  });

  it("is reported when a tab is open and the token scrape threw", async () => {
    const { probe } = harness({ openTab: true, scrapeThrows: true, verified: fresh });
    const s = await probe.status();
    expect(s.tokensReady).toBe(false);
    expect(s.verifiedAt).toBe(T0 - 5 * 60_000);
  });

  it("is reported alongside live tokens", async () => {
    const { probe } = harness({ openTab: true, verified: fresh });
    expect((await probe.status()).verifiedAt).toBe(T0 - 5 * 60_000);
  });

  it("is absent when the entry is older than twelve hours", async () => {
    const { probe } = harness({
      openTab: false,
      verified: { [USER]: { at: T0 - 12 * HOUR, xs: "h(xs-1)" } },
    });
    expect((await probe.status()).verifiedAt).toBeUndefined();
  });

  it("is absent when xs changed since the check", async () => {
    const { probe } = harness({ openTab: false, verified: fresh, xs: "xs-new" });
    expect((await probe.status()).verifiedAt).toBeUndefined();
  });

  it("is absent when there is no xs cookie", async () => {
    const { probe } = harness({ openTab: false, verified: fresh, xs: null });
    expect((await probe.status()).verifiedAt).toBeUndefined();
  });

  it("is absent when the entry belongs to a different user", async () => {
    const { probe } = harness({
      openTab: false,
      verified: { "999999999": { at: T0 - 60_000, xs: "h(xs-1)" } },
    });
    expect((await probe.status()).verifiedAt).toBeUndefined();
  });

  it("is absent when logged out, and the stored entry is left alone", async () => {
    // withAccount() empties the cookie jar for a moment during a swap; forgetting the
    // entry on that glimpse would lose a perfectly good check.
    const { probe, map } = harness({ loggedInAs: null, verified: fresh });
    const s = await probe.status();
    expect(s.verifiedAt).toBeUndefined();
    expect(map.get(VERIFIED_KEY)).toEqual(fresh);
  });

  it("is absent when nothing was ever verified", async () => {
    const { probe } = harness({ openTab: false });
    expect((await probe.status()).verifiedAt).toBeUndefined();
  });
});

describe("without storage", () => {
  it("behaves exactly as it did before the cache existed", async () => {
    const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cookies: CookiePort = {
      async get(_u, name) {
        return name === "c_user" ? ({ name, value: USER } as CookieRecord) : null;
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
        return null;
      },
      async reloadAndWait() {},
      async callContent<T>() {
        return { ok: true, data: PROFILE as T };
      },
    };
    const probe = new SessionProbe(cookies, tab, {} as TokenScraper, logger);
    expect((await probe.status()).profile).toEqual({ fbUserId: USER });
  });
});
