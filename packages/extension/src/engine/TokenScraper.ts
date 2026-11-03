import type { SessionTokens } from "@nashir/shared";
import type { TabPort, LoggerPort } from "./ports/index.js";

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
    return res.data;
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
