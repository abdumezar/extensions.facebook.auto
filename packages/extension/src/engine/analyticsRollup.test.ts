import { describe, it, expect } from "vitest";
import type { PostEvent, PostStatus } from "@nashir/shared";
import {
  MAX_BUCKETS,
  RECENT_LIMIT,
  buildReport,
  buildSeries,
  bucketForSpan,
  filterEvents,
  rangeStart,
  summarize,
  toCsv,
} from "./analyticsRollup.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

function ev(over: Partial<PostEvent> = {}): PostEvent {
  return {
    id: over.id ?? `e${Math.random()}`,
    ts: NOW,
    accountId: "acc1",
    campaignId: "camp1",
    runId: "run1",
    groupId: "g1",
    groupName: "Group One",
    status: "published" as PostStatus,
    ...over,
  };
}

describe("rangeStart", () => {
  it("opens the window at the start of the log for 'all'", () => {
    expect(rangeStart("all", NOW)).toBe(0);
  });

  it("walks back exactly one window for a fixed range", () => {
    expect(rangeStart("24h", NOW)).toBe(NOW - DAY);
    expect(rangeStart("7d", NOW)).toBe(NOW - 7 * DAY);
  });
});

describe("filterEvents", () => {
  const events = [
    ev({ id: "old", ts: NOW - 3 * DAY }),
    ev({ id: "recent", ts: NOW - HOUR }),
    ev({ id: "other-account", ts: NOW - HOUR, accountId: "acc2" }),
  ];

  it("drops events older than the window", () => {
    expect(filterEvents(events, { range: "24h" }, NOW).map((e) => e.id)).toEqual([
      "recent",
      "other-account",
    ]);
  });

  it("keeps everything for 'all'", () => {
    expect(filterEvents(events, { range: "all" }, NOW)).toHaveLength(3);
  });

  it("narrows to one account", () => {
    expect(filterEvents(events, { accountId: "acc2" }, NOW).map((e) => e.id)).toEqual([
      "other-account",
    ]);
  });
});

describe("summarize", () => {
  it("counts each outcome separately and never lets pending pass as published", () => {
    const s = summarize([
      ev({ status: "published" }),
      ev({ status: "published" }),
      ev({ status: "pending_approval" }),
      ev({ status: "submitted" }),
      ev({ status: "failed" }),
    ]);

    expect(s).toMatchObject({ total: 5, published: 2, pendingApproval: 1, submitted: 1, failed: 1 });
    // The rate is PUBLISHED over total — a post held for approval has reached nobody.
    expect(s.successRate).toBeCloseTo(0.4);
  });

  it("rolls pending and submitted together per account, since both mean 'not live'", () => {
    const s = summarize([
      ev({ accountId: "a", status: "published" }),
      ev({ accountId: "a", status: "pending_approval" }),
      ev({ accountId: "a", status: "submitted" }),
      ev({ accountId: "b", status: "failed" }),
    ]);

    expect(s.perAccount["a"]).toEqual({ total: 3, published: 1, pending: 2, failed: 0 });
    expect(s.perAccount["b"]).toEqual({ total: 1, published: 0, pending: 0, failed: 1 });
  });

  it("reports a median latency over the events that recorded one", () => {
    const s = summarize([
      ev({ latencyMs: 100 }),
      ev({ latencyMs: 900 }),
      ev({ latencyMs: 500 }),
      ev({}), // no latency recorded — must not count as 0
    ]);
    expect(s.medianLatencyMs).toBe(500);
  });

  it("is zero, not NaN, on an empty log", () => {
    const s = summarize([]);
    expect(s.successRate).toBe(0);
    expect(s.medianLatencyMs).toBe(0);
  });
});

describe("buildSeries", () => {
  it("emits empty buckets so a quiet stretch stays visible", () => {
    const series = buildSeries([ev({ ts: NOW })], HOUR, NOW - 3 * HOUR, NOW);
    expect(series).toHaveLength(4);
    expect(series.filter((p) => p.published > 0)).toHaveLength(1);
    expect(series[series.length - 1]!.published).toBe(1);
  });

  it("keeps buckets evenly spaced and ordered", () => {
    const series = buildSeries([], HOUR, NOW - 5 * HOUR, NOW);
    const gaps = series.slice(1).map((p, i) => p.bucketStart - series[i]!.bucketStart);
    expect(new Set(gaps)).toEqual(new Set([HOUR]));
  });

  it("caps the bucket count and keeps the NEWEST ones", () => {
    const series = buildSeries([], HOUR, NOW - 500 * HOUR, NOW);
    expect(series).toHaveLength(MAX_BUCKETS);
    expect(series[series.length - 1]!.bucketStart).toBe(Math.floor(NOW / HOUR) * HOUR);
  });

  it("counts submitted alongside pending — neither is live yet", () => {
    const series = buildSeries(
      [ev({ status: "submitted" }), ev({ status: "pending_approval" }), ev({ status: "failed" })],
      HOUR,
      NOW,
      NOW,
    );
    expect(series[0]).toMatchObject({ pending: 2, failed: 1, published: 0 });
  });
});

describe("bucketForSpan", () => {
  it("uses a fixed width per fixed range, so the axis reads the same every time", () => {
    expect(bucketForSpan("24h", DAY)).toBe(HOUR);
    expect(bucketForSpan("7d", 7 * DAY)).toBe(6 * HOUR);
    expect(bucketForSpan("30d", 30 * DAY)).toBe(DAY);
  });

  it("adapts to the log's own span for 'all'", () => {
    expect(bucketForSpan("all", 10 * 60_000)).toBeLessThan(HOUR);
    expect(bucketForSpan("all", 365 * DAY)).toBeGreaterThanOrEqual(7 * DAY);
  });

  it("never returns zero for an empty log", () => {
    expect(bucketForSpan("all", 0)).toBeGreaterThan(0);
  });
});

describe("buildReport", () => {
  it("returns newest-first recent events, capped", () => {
    const events = Array.from({ length: RECENT_LIMIT + 10 }, (_, i) =>
      ev({ id: `e${i}`, ts: NOW - i * 60_000 }),
    );
    const report = buildReport(events, { range: "all" }, NOW);

    expect(report.recent).toHaveLength(RECENT_LIMIT);
    expect(report.recent[0]!.id).toBe("e0");
    expect(report.recent[1]!.ts).toBeLessThan(report.recent[0]!.ts);
  });

  it("lists every account in the log, ignoring the account filter", () => {
    const report = buildReport(
      [ev({ accountId: "a" }), ev({ accountId: "b" })],
      { accountId: "a", range: "all" },
      NOW,
    );

    expect(report.summary.total).toBe(1);
    expect(report.accountIds.sort()).toEqual(["a", "b"]);
    expect(report.totalEvents).toBe(2);
  });

  it("survives an empty log without inventing a range", () => {
    const report = buildReport([], { range: "all" }, NOW);
    expect(report.summary.total).toBe(0);
    expect(report.bucketMs).toBeGreaterThan(0);
    expect(report.series.length).toBeGreaterThan(0);
  });

  it("spans the whole fixed window even when the log only covers part of it", () => {
    const report = buildReport([ev({ ts: NOW })], { range: "24h" }, NOW);
    const span =
      report.series[report.series.length - 1]!.bucketStart - report.series[0]!.bucketStart;
    expect(span).toBeGreaterThanOrEqual(23 * HOUR);
  });
});

describe("toCsv", () => {
  it("quotes fields and escapes embedded quotes rather than breaking the row", () => {
    const csv = toCsv([ev({ groupName: 'Cairo "Devs", Egypt', error: "line1\nline2" })]);
    const [header, row] = csv.split("\r\n");

    expect(header).toContain("groupName");
    expect(row).toContain('"Cairo ""Devs"", Egypt"');
    // A comma inside a quoted field must not add a column.
    expect(row!.split('","')).toHaveLength(10);
  });

  it("writes an ISO timestamp, not a raw epoch", () => {
    expect(toCsv([ev({ ts: NOW })])).toContain(new Date(NOW).toISOString());
  });

  /**
   * Group names and error strings are Facebook's text, not ours, and these exports are
   * meant to be opened in Excel — so a name that looks like a formula must not become one.
   */
  it("neutralises fields a spreadsheet would execute as a formula", () => {
    const attacks = ["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(A1)", "\t=1+1", "\r=1+1"];

    for (const attack of attacks) {
      const row = toCsv([ev({ groupName: attack })]).split("\r\n")[1]!;
      expect(row).toContain(`"'${attack.replace(/"/g, '""')}"`);
    }
  });

  it("leaves ordinary names untouched, including Arabic ones", () => {
    const row = toCsv([ev({ groupName: "مطورو دوت نت مصر" })]).split("\r\n")[1]!;
    expect(row).toContain('"مطورو دوت نت مصر"');
    expect(row).not.toContain("'مطورو");
  });
});
