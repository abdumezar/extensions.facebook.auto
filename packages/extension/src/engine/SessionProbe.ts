import type { FbProfile, SessionStatus } from "@nashir/shared";
import type { ClockPort, CookiePort, LoggerPort, StoragePort, TabPort } from "./ports/index.js";
import type { TokenScraper } from "./TokenScraper.js";
import { readVerifiedAt, sha256Hex, type HashFn } from "./verification.js";

const FB_URL = "https://www.facebook.com";

/** Last-known profile, keyed by nothing — there is one live browser session. */
export const SESSION_PROFILE_KEY = "nashir:session:profile";

/**
 * SessionProbe — answers "is Facebook reachable from this browser, and as whom?".
 *
 * Every screen in the dashboard opens with that question, and the honest answer has
 * three separable parts: a cookie says someone is logged in, a live page says the
 * session still works (tokens), and the page also carries their name and avatar.
 *
 * The probe deliberately prefers a tab the user already has open. Opening one is a
 * visible side effect, so it only happens when the caller explicitly asks for it.
 */
export class SessionProbe {
  constructor(
    private readonly cookies: CookiePort,
    private readonly tab: TabPort,
    private readonly scraper: TokenScraper,
    private readonly logger: LoggerPort,
    /**
     * Optional so existing call sites and tests keep working; without it the probe
     * simply has no memory and behaves exactly as it did before.
     */
    private readonly storage?: StoragePort,
    private readonly clock?: Pick<ClockPort, "now">,
    private readonly hash: HashFn = sha256Hex,
  ) {}

  /**
   * @param openTabIfNeeded open a background facebook.com tab when none exists.
   *   False (the default) keeps the probe invisible, at the cost of `tokensReady`
   *   being unknowable until the user has Facebook open.
   */
  async status(openTabIfNeeded = false): Promise<SessionStatus> {
    const cUser = await this.cookies.get(FB_URL, "c_user");
    const loggedIn = Boolean(cUser?.value);
    const openTabId = await this.tab.findFacebookTab();
    const hasOpenTab = openTabId != null;

    if (!loggedIn) {
      return { loggedIn: false, tokensReady: false, hasOpenTab };
    }
    // A live check made recently, even if the page that made it is gone. Attached to
    // every logged-in answer so the card can tell "checked 4 min ago" from "never".
    const verifiedAt = await this.verifiedAt(cUser!.value);

    if (!hasOpenTab && !openTabIfNeeded) {
      // Logged in as far as the cookie jar knows, but unverified against a live page.
      //
      // This is the common case on a fresh dashboard open, and returning a bare user
      // id here is what used to make the connection card read "100000000000001…" instead
      // of a person. The remembered profile costs no tab and no Facebook call, so it
      // is strictly better — as long as it is labelled as remembered.
      return {
        loggedIn: true,
        tokensReady: false,
        hasOpenTab,
        profile: (await this.remembered(cUser!.value)) ?? { fbUserId: cUser!.value },
        profileFresh: false,
        verifiedAt,
      };
    }

    try {
      const tokens = openTabIfNeeded
        ? await this.scraper.scrapeCurrent()
        : await this.scraper.scrapeFromOpenTab();
      const live = await this.profile(openTabIfNeeded);
      if (live) await this.remember(live);
      const profile = live ?? (await this.remembered(cUser!.value)) ?? { fbUserId: cUser!.value };
      return {
        loggedIn: true,
        tokensReady: Boolean(tokens),
        hasOpenTab,
        profile,
        profileFresh: Boolean(live),
        verifiedAt,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn("Session probe failed", { error });
      return {
        loggedIn: true,
        tokensReady: false,
        hasOpenTab,
        profile: (await this.remembered(cUser!.value)) ?? { fbUserId: cUser!.value },
        profileFresh: false,
        verifiedAt,
        error,
      };
    }
  }

  /**
   * When this session last passed a live check, if that is recent and still the same
   * login. Any failure to find out reads as "never": the card then just says what it
   * said before.
   */
  private async verifiedAt(fbUserId: string): Promise<number | undefined> {
    if (!this.storage) return undefined;
    try {
      const xs = await this.cookies.get(FB_URL, "xs");
      if (!xs?.value) return undefined;
      return await readVerifiedAt(
        this.storage,
        this.hash,
        fbUserId,
        xs.value,
        this.clock?.now() ?? Date.now(),
      );
    } catch {
      return undefined;
    }
  }

  /** Name / avatar / profile URL of whoever the active session belongs to. */
  async profile(openTabIfNeeded = false): Promise<FbProfile | null> {
    const tabId = openTabIfNeeded
      ? await this.tab.ensureFacebookTab()
      : await this.tab.findFacebookTab();
    if (tabId == null) return null;
    const res = await this.tab.callContent<FbProfile>(tabId, { type: "SCRAPE_PROFILE" });
    return res.ok && res.data ? res.data : null;
  }

  /**
   * Scrape and remember, when a Facebook page happens to be open anyway.
   *
   * Called from the tab-load listener, where the page is already loaded and the
   * scrape is a message to a content script — no tab opened, no Facebook request, no
   * call budget spent. That is the whole reason this is worth doing eagerly.
   */
  async refreshProfileIfPossible(): Promise<FbProfile | null> {
    try {
      const profile = await this.profile(false);
      if (profile?.name) await this.remember(profile);
      return profile;
    } catch {
      // Best-effort by definition. A page mid-navigation has no content script yet.
      return null;
    }
  }

  /**
   * The last profile we saw, if it still belongs to whoever is logged in now.
   *
   * The id check is the point: without it, logging into a second account would keep
   * showing the first one's name and face on the card that says which account is
   * about to post.
   */
  private async remembered(fbUserId: string): Promise<FbProfile | null> {
    if (!this.storage) return null;
    const cached = await this.storage.get<FbProfile>(SESSION_PROFILE_KEY);
    if (!cached || cached.fbUserId !== fbUserId) return null;
    return cached;
  }

  private async remember(profile: FbProfile): Promise<void> {
    // A profile with no name is what we are trying to improve on — never overwrite a
    // good cache with one.
    if (!this.storage || !profile.name) return;
    await this.storage.set(SESSION_PROFILE_KEY, profile);
  }
}
