import type { PostStatus } from "./post.js";

/**
 * The Phase-1 feasibility gate, as data.
 *
 * The go/no-go rests on three things being true against REAL Facebook, none of
 * which a unit test can establish: a post lands (1a), a cookie swap round-trips without
 * corrupting the user's own session (1b), and there is a sustainable posting cadence (1c).
 * These types are the record of having actually checked.
 *
 * NOTE: evidence carries STRUCTURAL facts only — status strings, ids we already store,
 * counts, latencies, booleans. Session secrets (fb_dtsg, lsd, jazoest, xs) are never put
 * in a StepResult; where their presence matters we record a length or a boolean instead.
 */

export type CheckId = "post" | "swap" | "ramp";

/**
 * `warn` exists because some preconditions are advisory — a second Facebook tab makes a
 * cookie swap unsafe but does not invalidate a plain post — and a warning must not halt
 * a check the way a `fail` does.
 */
export type StepStatus = "pending" | "running" | "pass" | "warn" | "fail" | "skipped";

export interface StepResult {
  /** Stable id, used as the i18n key suffix: `feasibility.step.<id>`. */
  id: string;
  status: StepStatus;
  /** Free text from the engine (an FB error, a mismatch) — shown verbatim, not translated. */
  detail?: string;
  evidence?: Record<string, string | number | boolean>;
  at?: number;
  latencyMs?: number;
}

/** `partial` = the check ran to the end but something advisory failed. */
export type CheckVerdict = "unrun" | "running" | "pass" | "partial" | "fail";

export interface CheckRecord {
  id: CheckId;
  verdict: CheckVerdict;
  steps: StepResult[];
  startedAt?: number;
  finishedAt?: number;
}

/** One rung of the rate ladder: hold this cadence for this many posts. */
export interface RampTier {
  postsPerHour: number;
  posts: number;
}

export interface RampPost {
  at: number;
  tierPostsPerHour: number;
  groupId: string;
  status: PostStatus;
  latencyMs?: number;
  error?: string;
  /** The error matched a rate-limit signal — this is what ends the ramp. */
  throttled: boolean;
}

export interface RampConfig {
  accountId: string;
  /** Cycled in order; the ramp needs several groups so it is not spamming one. */
  groupIds: string[];
  message: string;
  tiers: RampTier[];
  /** Hard ceiling on total posts, independent of the tiers. Belt and braces. */
  cap: number;
}

export interface RampState {
  config: RampConfig;
  status: "running" | "aborted" | "throttled" | "completed";
  tierIndex: number;
  /** Posts completed in the current tier. */
  postsInTier: number;
  postsDone: number;
  startedAt: number;
  finishedAt?: number;
  nextWakeAt?: number;
  posts: RampPost[];
  /**
   * The fastest cadence that ran a full tier without a throttle — the number Phase 1c
   * exists to produce, and what `SafetyPolicy`'s defaults should be derived from.
   */
  ceilingPostsPerHour?: number;
}

export interface FeasibilityRecord {
  version: 1;
  checks: Record<CheckId, CheckRecord>;
  ramp?: RampState;
  updatedAt: number;
}

/** Delay settings derived from a measured ceiling, ready to apply to a campaign draft. */
export interface MeasuredDefaults {
  ceilingPostsPerHour: number;
  minSeconds: number;
  maxSeconds: number;
  /** Posts before a safety break, and how long it lasts. */
  breakEveryNPosts: number;
  breakSeconds: number;
  dailyBudgetPerAccount: number;
  /**
   * The measured ceiling expressed as CALLS per hour, not posts.
   *
   * The ramp posts text only, so its ceiling is a one-call-per-post number. A campaign
   * with a video attached spends a start, a chunk per slice and a receive on every
   * post — twenty-odd calls where the ramp measured one. Handing the post cadence
   * straight to such a campaign was silently unsafe; the call figure is what the
   * governor can actually hold a mixed workload to.
   */
  callBudgetPerHour: number;
}
