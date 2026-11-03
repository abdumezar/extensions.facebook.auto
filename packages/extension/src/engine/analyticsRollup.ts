import type {
  AccountRollup,
  AnalyticsQuery,
  AnalyticsRange,
  AnalyticsReport,
  AnalyticsSummary,
  PostEvent,
  TimePoint,
} from "@nashir/shared";

/**
 * Pure rollup math over the analytics event log — no IndexedDB, no chrome.*, no clock.
 * `AnalyticsStore` reads the events; everything that turns them into numbers lives here
 * so it can be tested directly, the same split `SafetyPolicy` uses for timing.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RANGE_MS: Record<Exclude<AnalyticsRange, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

/** Bucket widths the "all" range may pick from, coarsest last. */
const BUCKET_LADDER = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY];

/** Upper bound on rendered bars. Past this the chart is noise, not information. */
export const MAX_BUCKETS = 60;

/** How many recent events the report carries back to the page. */
export const RECENT_LIMIT = 25;

/** Start of the window, or 0 for "all" (i.e. the beginning of the log). */
export function rangeStart(range: AnalyticsRange, now: number): number {
  return range === "all" ? 0 : Math.max(0, now - RANGE_MS[range]);
}

/**
 * Bucket width for a window. Fixed ranges get a fixed width so the axis reads the same
 * every time; "all" adapts to whatever the log actually spans, which may be ten minutes
 * on day one and six months later on.
 */
export function bucketForSpan(range: AnalyticsRange, spanMs: number): number {
  if (range === "24h") return HOUR;
  if (range === "7d") return 6 * HOUR;
  if (range === "30d") return DAY;
  const target = Math.max(spanMs, MINUTE) / 24;
  return BUCKET_LADDER.find((b) => b >= target) ?? BUCKET_LADDER[BUCKET_LADDER.length - 1]!;
}

export function filterEvents(events: PostEvent[], query: AnalyticsQuery, now: number): PostEvent[] {
  const from = rangeStart(query.range ?? "all", now);
  return events.filter(
    (e) =>
      e.ts >= from &&
      (!query.accountId || e.accountId === query.accountId) &&
      (!query.campaignId || e.campaignId === query.campaignId),
  );
}

export function summarize(events: PostEvent[]): AnalyticsSummary {
  const summary: AnalyticsSummary = {
    total: events.length,
    published: 0,
    pendingApproval: 0,
    submitted: 0,
    failed: 0,
    successRate: 0,
    medianLatencyMs: 0,
    perAccount: {},
  };

  const latencies: number[] = [];

  for (const e of events) {
    const bucket: AccountRollup = (summary.perAccount[e.accountId] ??= {
      total: 0,
      published: 0,
      pending: 0,
      failed: 0,
    });
    bucket.total++;

    switch (e.status) {
      case "published":
        summary.published++;
        bucket.published++;
        break;
      case "pending_approval":
        summary.pendingApproval++;
        bucket.pending++;
        break;
      case "submitted":
        summary.submitted++;
        bucket.pending++;
        break;
      default:
        summary.failed++;
        bucket.failed++;
    }

    if (typeof e.latencyMs === "number" && e.latencyMs >= 0) latencies.push(e.latencyMs);
  }

  summary.successRate = summary.total > 0 ? summary.published / summary.total : 0;
  summary.medianLatencyMs = median(latencies);
  return summary;
}

/**
 * Roll events into evenly spaced buckets, INCLUDING the empty ones. A chart drawn only
 * from buckets that have events silently closes the gaps — a quiet night would look
 * identical to a busy one.
 */
export function buildSeries(
  events: PostEvent[],
  bucketMs: number,
  from: number,
  to: number,
): TimePoint[] {
  if (bucketMs <= 0 || to < from) return [];

  const first = Math.floor(from / bucketMs) * bucketMs;
  const last = Math.floor(to / bucketMs) * bucketMs;
  const count = Math.min(MAX_BUCKETS, Math.floor((last - first) / bucketMs) + 1);
  // When the span exceeds the cap, keep the NEWEST buckets: recent activity is the
  // part anyone reads a chart for.
  const start = last - (count - 1) * bucketMs;

  const points: TimePoint[] = [];
  const index = new Map<number, TimePoint>();
  for (let i = 0; i < count; i++) {
    const point: TimePoint = { bucketStart: start + i * bucketMs, published: 0, failed: 0, pending: 0 };
    points.push(point);
    index.set(point.bucketStart, point);
  }

  for (const e of events) {
    const point = index.get(Math.floor(e.ts / bucketMs) * bucketMs);
    if (!point) continue;
    if (e.status === "published") point.published++;
    else if (e.status === "failed") point.failed++;
    else point.pending++;
  }

  return points;
}

/** One pass over the log producing everything the analytics view renders. */
export function buildReport(events: PostEvent[], query: AnalyticsQuery, now: number): AnalyticsReport {
  const range = query.range ?? "all";
  const filtered = filterEvents(events, query, now);

  // "all" spans the log itself; a fixed range spans its own window even where the log
  // is empty, so the chart shows the quiet stretch rather than cropping it away.
  const earliest = filtered.length > 0 ? Math.min(...filtered.map((e) => e.ts)) : now;
  const from = range === "all" ? earliest : rangeStart(range, now);
  const bucketMs = bucketForSpan(range, Math.max(0, now - from));

  return {
    summary: summarize(filtered),
    series: buildSeries(filtered, bucketMs, from, now),
    bucketMs,
    recent: [...filtered].sort((a, b) => b.ts - a.ts).slice(0, RECENT_LIMIT),
    accountIds: [...new Set(events.map((e) => e.accountId))],
    totalEvents: events.length,
  };
}

/** RFC-4180 CSV: quote every field, double the quotes inside it. */
export function toCsv(events: PostEvent[]): string {
  const header = ["timestamp", "accountId", "campaignId", "runId", "groupId", "groupName", "status", "error", "latencyMs", "permalink"];
  const rows = events.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.accountId,
      e.campaignId,
      e.runId,
      e.groupId,
      e.groupName,
      e.status,
      e.error ?? "",
      e.latencyMs != null ? String(e.latencyMs) : "",
      e.permalink ?? "",
    ]
      .map(csvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

/**
 * Leading characters a spreadsheet reads as the start of a formula rather than text.
 * Tab and CR are here because Excel strips them before deciding, so "\t=cmd" is still
 * a formula to it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV field: quoted, inner quotes doubled, and neutralised if a spreadsheet would
 * otherwise execute it.
 *
 * The neutralising matters because none of this text is ours — group names and error
 * strings come back from Facebook, and a group named `=cmd|'/c calc'!A1` becomes a live
 * formula the moment the export is opened in Excel. RFC-4180 quoting does NOT stop that;
 * Excel parses the quotes off first and evaluates what is left. Prefixing an apostrophe
 * is the standard fix: Excel treats the rest as literal text and hides the marker, so
 * the cell still reads as the original name.
 */
export function csvField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}
