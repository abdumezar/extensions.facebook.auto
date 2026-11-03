import type { SessionTokens } from "@nashir/shared";
import type { ClockPort, CookiePort, LoggerPort, StoragePort, TabPort } from "./ports/index.js";
import { markVerified, sha256Hex, type HashFn } from "./verification.js";

const FB_URL = "https://www.facebook.com";

/**
 * TokenScraper — obtains fresh Facebook session tokens for the CURRENTLY active
 * session by asking the content script (which runs on a real logged-in FB page).
 *
 * Ordering rule enforced by callers: after a cookie swap, reload the FB tab, THEN
 * scrape — tokens are per-session and must reflect the just-swapped account.
 */
export class TokenScraper {
  constructor(
    private readonly tab: TabPort,
    private readonly logger: LoggerPort,
    /**
     * A full facebook.com reload is the single most expensive thing this extension
     * does to Facebook — dozens of requests — and it never touches `HttpPort`, so the
     * transport decorator cannot see it. It is billed explicitly here instead.
     */
    private readonly governor?: {
      acquire(domain: "www", cls: "page.load", accountId?: string): Promise<void>;
    },
    /**
     * With `cookies`, lets a successful scrape be remembered as a live check of that
     * session (see `verification.ts`). Optional so existing call sites and tests keep
     * working; without them the scraper behaves exactly as it did before.
     */
    private readonly storage?: StoragePort,
    private readonly cookies?: CookiePort,
    private readonly clock?: Pick<ClockPort, "now">,
    private readonly hash: HashFn = sha256Hex,
  ) {}

  async scrapeCurrent(): Promise<SessionTokens> {
    const tabId = await this.tab.ensureFacebookTab();
    const res = await this.tab.callContent<SessionTokens>(tabId, { type: "SCRAPE_TOKENS" });
    if (!res.ok || !res.data) {
      throw new Error(res.error ?? "Token scrape failed");
    }
    const tokens = res.data;
    if (!this.validate(tokens)) {
      throw new Error("Scraped tokens failed validation (fb_dtsg missing/short)");
    }
    await this.markVerified(tokens);
    return tokens;
  }

  /**
   * Scrape from a facebook.com tab the user already has open, or return null.
   *
   * Unlike `scrapeCurrent` this never opens a tab, which is what makes it safe for
   * background work: no session is disturbed and nothing appears in the user's window.
   */
  async scrapeFromOpenTab(): Promise<SessionTokens | null> {
    const tabId = await this.tab.findFacebookTab();
    if (tabId == null) return null;
    const res = await this.tab.callContent<SessionTokens>(tabId, { type: "SCRAPE_TOKENS" });
    if (!res.ok || !res.data || !this.validate(res.data)) return null;
    await this.markVerified(res.data);
    return res.data;
  }

  /** Reload the FB tab first (post cookie-swap), then scrape for the new session. */
  async scrapeAfterSwap(): Promise<SessionTokens> {
    const tabId = await this.tab.ensureFacebookTab();
    await this.governor?.acquire("www", "page.load");
    await this.tab.reloadAndWait(tabId);
    const res = await this.tab.callContent<SessionTokens>(tabId, { type: "SCRAPE_TOKENS" });
    if (!res.ok || !res.data) throw new Error(res.error ?? "Token scrape (post-swap) failed");
    if (!this.validate(res.data)) throw new Error("Post-swap tokens failed validation");
    await this.markVerified(res.data);
    return res.data;
  }

  /**
   * Remember that this session just passed a live check.
   *
   * Keyed by the `c_user` cookie as it is right now, and skipped when the scraped user
   * is someone else: a cookie swap can land between the scrape and this read, and
   * crediting the wrong account would be worse than recording nothing. Never throws —
   * a scrape that worked must not fail because the note about it could not be saved.
   */
  private async markVerified(tokens: SessionTokens): Promise<void> {
    if (!this.storage || !this.cookies) return;
    try {
      const cUser = await this.cookies.get(FB_URL, "c_user");
      const xs = await this.cookies.get(FB_URL, "xs");
      if (!cUser?.value || !xs?.value || cUser.value !== tokens.user) return;
      await markVerified(
        this.storage,
        this.hash,
        cUser.value,
        xs.value,
        this.clock?.now() ?? Date.now(),
      );
    } catch (err) {
      this.logger.warn("Could not record verified session", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  validate(t: SessionTokens): boolean {
    return (
      typeof t.fb_dtsg === "string" &&
      t.fb_dtsg.length >= 8 &&
      typeof t.user === "string" &&
      t.user.length > 0
    );
  }
}
