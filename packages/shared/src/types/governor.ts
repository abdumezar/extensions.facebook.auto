/**
 * Call-governance types.
 *
 * Facebook's throttle copy is caller-attributed — "there have been too many calls from
 * this app" — so the quantity that matters is calls per hour summed across every
 * subsystem, not posts per hour. `SafetyPolicy` paces posts; this pages the *calls*
 * those posts (and group syncs, and leaves, and uploads) actually cost.
 */

/**
 * What a request is for. Budgets belong to classes of work, not to URLs: a group
 * pagination page and a composer mutation cost Facebook very different amounts of
 * goodwill, and only the class knows which is which.
 */
export type EndpointClass =
  | "mutation.post"
  | "mutation.leave"
  | "read.groups"
  | "read.dialog"
  | "read.preview"
  /**
   * Reading a post's audience: the reactions dialog and the comment thread, plus
   * their pagination. Its own class because it is the only read that paginates
   * without a natural end — a post with 4k reactions is 80 calls if nothing stops
   * it, which is a third of the hourly `www` budget spent on one post.
   */
  | "read.audience"
  /**
   * Reading a group's own feed, for Lead Radar. Separate from `read.groups` because
   * it is the only *recurring unattended* read in the product: it runs on a timer
   * whether or not anyone is at the keyboard, so it needs a budget line that can be
   * tightened without also slowing down the group sync a person is waiting on.
   */
  | "read.feed"
  /** Posting a comment — the auto first-comment, and a Lead Radar reply. */
  | "mutation.comment"
  /** Joining a group. The single most ban-associated action in this category. */
  | "mutation.join"
  | "upload.photo"
  | "upload.video"
  | "page.load"
  | "other";

/**
 * Which pool a call is drawn from. Uploads hit a different Facebook edge
 * (upload/vupload) than the composer, and a 40-chunk video must not starve the
 * posting budget, so the two are accounted separately.
 */
export type BudgetDomain = "www" | "upload";

/** Why Facebook pushed back, in descending order of how long it lasts. */
export type ThrottleClass =
  | "none"
  /** 5xx / network. Not a cooldown — one retry is correct here. */
  | "transient"
  /** Codes 4/17/32/341/613, the 80000-series, HTTP 429, or throttle copy. */
  | "rate_limit"
  /** Code 368 and "temporarily blocked" copy. Hours to days. */
  | "policy_block"
  /** Code 601 / checkpoint copy. Indefinite — only a human clears it. */
  | "checkpoint";

/** Who the block applies to. Code 4 is app-wide; code 17 and checkpoints are per-user. */
export type CooldownScope = "global" | "account";

/** The verdict of classifying one response. Pure data — no clock, no storage. */
export interface ThrottleVerdict {
  class: ThrottleClass;
  scope: CooldownScope;
  /** Server-stated wait. From Retry-After or estimated_time_to_regain_access. Authoritative. */
  retryAfterMs?: number;
  /** The numeric Facebook error code, when the body carried one. */
  code?: number;
  subcode?: number;
  /**
   * 0..1 utilisation from X-App-Usage / x-fb-ads-insights-throttle. Graph API sends
   * these; the internal www endpoints generally do not, so treat it as a bonus.
   */
  pressure?: number;
  /** Facebook's own words, truncated. This is what the operator is shown. */
  evidence?: string;
  /** Which rule fired — so unrecognised copy can be added to the recipe from a log line. */
  matchedSignal?: string;
}

/** A live block. Persisted, because a cooldown that dies with the service worker is not a cooldown. */
export interface CooldownState {
  since: number;
  untilMs: number;
  scope: CooldownScope;
  accountId?: string;
  reason: ThrottleClass;
  /** Facebook's verbatim message, capped at 500 chars. Never a request body. */
  evidence: string;
  matchedSignal: string;
  /** Position on the ladder. Resets after an hour of clean calls. */
  consecutive: number;
  /** Checkpoints have no timer — only a human in a Facebook tab clears them. */
  requiresOperator: boolean;
}

/** Everything tunable about pacing. Overridable from the recipe. */
export interface CallBudgetConfig {
  perDomain: Record<BudgetDomain, { perMinute: number; perHour: number }>;
  /** Rolling-hour ceiling for one account on the `www` domain. */
  perAccountPerHour: number;
  /** Minimum gap between two calls of the same class, before jitter. */
  spacingMs: Record<EndpointClass, number>;
  /** ±fraction applied to every spacing so the cadence is not machine-regular. */
  jitterFrac: number;
  /** Concurrent mutations. 1, always — this is a safety property, not a tuning knob. */
  mutationConcurrency: number;
  /** Utilisation (0..100) above which every spacing doubles. Meta: back off before 100%. */
  softThresholdPct: number;
  /** The cooldown ladder, in ms. The last entry is the cap. */
  cooldownLadderMs: number[];
  /** Clean calls for this long reset the ladder. */
  cooldownResetAfterCleanMs: number;
  /**
   * A wait longer than this is refused rather than slept. The service worker is
   * evicted at ~30s idle, so a long setTimeout loses the call entirely.
   */
  maxSyncWaitMs: number;
}

/** The answer to "may I call now?". Side-effect free when it comes from `check`. */
export interface GovernorVerdict {
  allowed: boolean;
  /** How long the caller must wait. 0 when allowed. */
  waitMs: number;
  /** Set when the wait is too long to sit through — the caller reschedules or skips. */
  retryAtMs?: number;
  /** Why it was refused, for the log line. */
  reason?: "cooldown" | "spacing" | "minute_budget" | "hour_budget" | "account_budget";
  cooldown?: CooldownState;
}

/** What the dashboard renders. A cooldown outlives any single run, so this is not on RunSnapshot. */
export interface GovernorSnapshot {
  cooldown: CooldownState | null;
  callsLastMinute: number;
  callsLastHour: number;
  byClass: Partial<Record<EndpointClass, number>>;
  byAccount: Record<string, number>;
  lastThrottleAt: number | null;
}
