import type { PostStatus } from "./post.js";

/** An append-only analytics event, one per post attempt. */
export interface PostEvent {
  id: string;
  ts: number;
  accountId: string;
  campaignId: string;
  runId: string;
  groupId: string;
  groupName: string;
  status: PostStatus;
  error?: string;
  latencyMs?: number;
  permalink?: string;
}

export interface AccountRollup {
  total: number;
  published: number;
  pending: number;
  failed: number;
}

export interface AnalyticsSummary {
  total: number;
  published: number;
  pendingApproval: number;
  submitted: number;
  failed: number;
  /** published / total. */
  successRate: number;
  /** Median round-trip of the post request, over events that recorded one. */
  medianLatencyMs: number;
  perAccount: Record<string, AccountRollup>;
}

export interface TimePoint {
  bucketStart: number;
  published: number;
  failed: number;
  pending: number;
}

/** Windows the analytics page offers. `all` spans the whole event log. */
export type AnalyticsRange = "24h" | "7d" | "30d" | "all";

export interface AnalyticsQuery {
  /** Restrict to one posting account. Omitted = every account. */
  accountId?: string;
  campaignId?: string;
  range?: AnalyticsRange;
}

/**
 * Everything the analytics view needs, computed in one pass over the log so the page
 * never has to make three round-trips that could disagree with each other.
 */
export interface AnalyticsReport {
  summary: AnalyticsSummary;
  series: TimePoint[];
  /** Bucket width the series was rolled up at, so the chart can label its axis. */
  bucketMs: number;
  /** Newest first, capped — the page shows a tail, not the whole log. */
  recent: PostEvent[];
  /** Every account present in the log, ignoring the current filter, for the filter control. */
  accountIds: string[];
  /** Size of the whole log, ignoring filters. */
  totalEvents: number;
}
