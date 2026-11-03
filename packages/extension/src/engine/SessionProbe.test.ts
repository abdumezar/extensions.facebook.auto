import type { FbProfile } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { SESSION_PROFILE_KEY, SessionProbe } from "./SessionProbe.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { CookiePort, CookieRecord, LoggerPort, StoragePort, TabPort } from "./ports/index.js";

const USER = "100000000000001";
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
}) {
  const map = new Map<string, unknown>();
  if (opts.cached) map.set(SESSION_PROFILE_KEY, opts.cached);

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
    probe: new SessionProbe(cookies, tab, scraper, logger, storage),
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
