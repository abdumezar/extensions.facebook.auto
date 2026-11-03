import type { PostEvent, AnalyticsQuery, AnalyticsReport } from "@nashir/shared";
import { openDB, type IDBPDatabase } from "idb";
import { buildReport, toCsv } from "./analyticsRollup.js";

/**
 * AnalyticsStore — the append-only post-event log, backed by IndexedDB (event volume
 * outgrows chrome.storage's quota quickly). This class owns storage only; the maths
 * that turns events into a report lives in `analyticsRollup.ts`, testable on its own.
 */
export class AnalyticsStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB("nashir-analytics", 1, {
        upgrade(db) {
          const store = db.createObjectStore("events", { keyPath: "id" });
          store.createIndex("by_ts", "ts");
          store.createIndex("by_campaign", "campaignId");
          store.createIndex("by_account", "accountId");
        },
      });
    }
    return this.dbPromise;
  }

  async record(ev: PostEvent): Promise<void> {
    const db = await this.db();
    await db.put("events", ev);
  }

  /** Oldest first. */
  async all(): Promise<PostEvent[]> {
    const db = await this.db();
    return (await db.getAllFromIndex("events", "by_ts")) as PostEvent[];
  }

  /** Summary + time series + recent tail for one query, from a single read. */
  async report(query: AnalyticsQuery = {}, now: number = Date.now()): Promise<AnalyticsReport> {
    return buildReport(await this.all(), query, now);
  }

  async exportJson(): Promise<string> {
    return JSON.stringify(await this.all(), null, 2);
  }

  async exportCsv(): Promise<string> {
    return toCsv(await this.all());
  }

  /** Wipe the log. The events are the only record of past runs — callers must confirm. */
  async clear(): Promise<void> {
    const db = await this.db();
    await db.clear("events");
  }
}
