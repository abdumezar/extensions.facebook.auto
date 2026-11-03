/**
 * Facebook session tokens scraped from a live logged-in page.
 * These rotate frequently, so they are always captured fresh per account per run,
 * AFTER a cookie swap (never cached across accounts).
 */
export interface SessionTokens {
  /** CSRF token — the critical one. */
  fb_dtsg: string;
  /** Derived checksum of fb_dtsg. */
  jazoest: string;
  /** Client-side session token. */
  lsd: string;
  /** Logged-in user id (matches the c_user cookie). */
  user: string;
  /** Actor id used by GraphQL (`av`). Usually equals `user`. */
  av: string;
  /** Spin params for the GraphQL endpoint (versioning). */
  spinR: string;
  spinB: string;
  spinT: string;
  /** Comet request marker. */
  cometReq: string;
  /** Haste session / revision, when available. */
  hasteSession?: string;
  /** Epoch millis the tokens were scraped — used for staleness checks. */
  scrapedAt: number;
}

/** Result of classifying an account's live session after a cookie swap. */
export type AccountHealth = "ok" | "logged_out" | "checkpoint" | "unknown";
