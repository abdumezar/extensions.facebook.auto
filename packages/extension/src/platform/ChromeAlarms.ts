import type { ClockPort } from "../engine/ports/index.js";

/**
 * ClockPort backed by chrome.alarms. Sub-minute waits use a one-shot `when` timestamp;
 * chrome.alarms enforces a ~30s effective minimum in packed builds, which is finer than
 * our safe posting cadence, so this is fine.
 */
export class ChromeAlarms implements ClockPort {
  now(): number {
    return Date.now();
  }

  async scheduleWake(name: string, atEpochMs: number): Promise<void> {
    await chrome.alarms.clear(name);
    // chrome.alarms fires no sooner than ~30s out in production; clamp to a small floor.
    const when = Math.max(atEpochMs, Date.now() + 1000);
    await chrome.alarms.create(name, { when });
  }

  async clearWake(name: string): Promise<void> {
    await chrome.alarms.clear(name);
  }
}
