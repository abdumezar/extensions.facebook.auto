import type { AccountHealth } from "./tokens.js";

/** The Facebook auth cookies that constitute a session (stored encrypted at rest). */
export interface AccountAuth {
  c_user: string;
  xs: string;
  fr?: string;
  datr?: string;
  sb?: string;
  /** Any additional cookies captured for fidelity (name -> value). */
  extra?: Record<string, string>;
}

/**
 * The pseudo-account id meaning "whoever is logged into this browser right now".
 * Work addressed to it never swaps cookies, so it is also the only id that is safe
 * to use while the user has Facebook open in another tab.
 */
export const CURRENT_SESSION = "current";

/**
 * What a live Facebook page can tell us about whoever is logged in: the real name,
 * the avatar and the vanity URL. Scraped from the page, never from an API token.
 */
export interface FbProfile {
  fbUserId: string;
  /** Full name as Facebook renders it. */
  name?: string;
  /** Profile picture URL. CDN-signed, so it expires — re-scrape rather than trust it forever. */
  avatarUrl?: string;
  /** Vanity or numeric profile URL. */
  profileUrl?: string;
}

/** A managed Facebook account. Auth is stored separately (encrypted); this is metadata. */
export interface Account {
  id: string;
  /** Facebook user id (c_user). */
  fbUserId: string;
  /** Display label — the user's own name for this account, defaulting to the scraped name. */
  label: string;
  /** Real name scraped from Facebook, kept apart from `label` so a rename survives a re-scrape. */
  name?: string;
  /** Profile picture URL, if scraped. Expires — refreshed by a profile re-scrape. */
  avatarUrl?: string;
  /** Link to the account's Facebook profile. */
  profileUrl?: string;
  /** When the profile (name/avatar) was last scraped. */
  profileScrapedAt?: number;
  /** When this account's cookies were captured on THIS device. */
  addedAt: number;
  /** Last known session health. */
  health: AccountHealth;
  /** Last time we successfully posted / validated. */
  lastActiveAt?: number;
  /** Per-day post counter, keyed by YYYY-MM-DD, for daily rate budgets. */
  dailyCounts: Record<string, number>;
}

/**
 * The live browser session as the dashboard sees it. Answers the one question every
 * screen opens with: is Facebook reachable from here, and as whom?
 */
export interface SessionStatus {
  /** A c_user cookie exists for facebook.com. */
  loggedIn: boolean;
  /** Session tokens were scrapable — the precondition for loading groups or posting. */
  tokensReady: boolean;
  /** True when a facebook.com tab is already open, so probing costs nothing. */
  hasOpenTab: boolean;
  profile?: FbProfile;
  /**
   * True when `profile` was read from a live page just now; false when it is the
   * last-known one, remembered from a previous session.
   *
   * The distinction is shown, not hidden. A remembered name is worth far more than a
   * numeric id — it is the difference between "100000000000001..." and "Layla" on the
   * card that tells you which account you are about to post from — but presenting it
   * as live would mean the UI keeps naming an account the user has since logged out of.
   */
  profileFresh?: boolean;
  /** Why `tokensReady` is false, when we know. */
  error?: string;
}

/** Encrypted-at-rest envelope for an AccountAuth (AES-GCM). */
export interface SealedAuth {
  accountId: string;
  /** base64 ciphertext. */
  ct: string;
  /** base64 IV. */
  iv: string;
  /** Key derivation version, for future rotation. */
  v: number;
}
