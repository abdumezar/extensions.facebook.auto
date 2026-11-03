import type { ThrottleVerdict } from "./governor.js";

/**
 * Outcome of submitting one post to Facebook.
 * Critically distinguishes "published" from "pending admin approval" — a 200 from
 * FB often means queued, not live.
 */
export type PostStatus =
  | "published"
  | "pending_approval"
  | "submitted" // accepted by FB but publish state unknown
  | "failed";

export interface PostResult {
  status: PostStatus;
  /** FB post/story id, when returned. */
  postId?: string;
  /** Direct permalink to the post, when derivable. */
  permalink?: string;
  /** Error message/code on failure. */
  error?: string;
  /** Whether this was the retry attempt. */
  wasRetry?: boolean;
  /** Round-trip latency in ms. */
  latencyMs?: number;
  /**
   * Set when Facebook pushed back rather than rejecting the content.
   *
   * Deliberately a field rather than a new `PostStatus` member: "throttled" is not an
   * outcome of a post, it is the absence of one. Widening PostStatus would ripple
   * through AnalyticsStore, analyticsRollup, SummaryModal, the CSV export, the volume
   * chart and both i18n bundles for a distinction none of them needs to draw.
   */
  throttle?: ThrottleVerdict;
  /**
   * Set when the call never left the extension — the call governor held it back for
   * pacing or budget.
   *
   * This is not a failed post; it is a post that has not been attempted yet, and the
   * engine must not consume its queue slot. Distinct from `throttle`, which means
   * Facebook itself answered and told us to stop.
   */
  deferredUntil?: number;
}

/** One unit of work in a campaign queue: post caption X to group Y as account Z. */
export interface PostJob {
  id: string;
  accountId: string;
  groupId: string;
  groupName: string;
  /** Which caption variation (index into campaign.variations). */
  variationIndex: number;
  /** Resolved caption text at enqueue time. */
  message: string;
  /** Uploaded photo ids to attach (resolved lazily during the run). */
  photoIds?: string[];
  /** Uploaded video ids to attach (resolved lazily during the run). */
  videoIds?: string[];
  /** Chosen link URL for a preview card, if any. */
  linkUrl?: string;
  /** Epoch millis to schedule the FB post at (native scheduling), if any. */
  scheduledAt?: number;
}
