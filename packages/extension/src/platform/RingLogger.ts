import type { LoggerPort } from "../engine/ports/index.js";
import type { StoragePort } from "../engine/ports/index.js";

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

const LOG_KEY = "nashir:logs";
const MAX = 500;

/**
 * LoggerPort that mirrors to the console and keeps a bounded ring buffer in
 * chrome.storage so the dashboard's event log survives service worker restarts.
 */
export class RingLogger implements LoggerPort {
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storage: StoragePort) {}

  info(msg: string, meta?: Record<string, unknown>) {
    this.push("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>) {
    this.push("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>) {
    this.push("error", msg, meta);
  }

  async getLogs(): Promise<LogEntry[]> {
    return (await this.storage.get<LogEntry[]>(LOG_KEY)) ?? [];
  }

  async clear(): Promise<void> {
    this.buffer = [];
    await this.storage.set(LOG_KEY, []);
  }

  private push(level: LogEntry["level"], msg: string, meta?: Record<string, unknown>) {
    const entry: LogEntry = { ts: Date.now(), level, msg, meta };
    // eslint-disable-next-line no-console
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[nashir] ${msg}`, meta ?? "");
    this.buffer.push(entry);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 500);
  }

  private async flush() {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const existing = await this.getLogs();
    const merged = [...existing, ...this.buffer].slice(-MAX);
    this.buffer = [];
    await this.storage.set(LOG_KEY, merged);
  }
}
