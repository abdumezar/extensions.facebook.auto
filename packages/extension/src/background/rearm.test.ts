import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeAlarms } from "../platform/ChromeAlarms.js";
import { ALARM_ENGAGEMENT, TICK_INTERVAL_MS } from "../engine/EngagementService.js";
import { ALARM_RADAR, RADAR_INTERVAL_MS } from "../engine/LeadRadarService.js";
import { rearmFeatureAlarms } from "./rearm.js";

const NOW = 1_700_000_000_000;

/** chrome.alarms with just enough behaviour: a set of named alarms and their times. */
function fakeAlarms(existing: string[] = []) {
  const alarms = new Map<string, number>(existing.map((name) => [name, NOW]));
  vi.stubGlobal("chrome", {
    alarms: {
      get: async (name: string) => (alarms.has(name) ? { name, scheduledTime: alarms.get(name) } : undefined),
      clear: async (name: string) => alarms.delete(name),
      create: async (name: string, info: { when: number }) => void alarms.set(name, info.when),
    },
  });
  return alarms;
}

const features = (radar: boolean, engagement: boolean) => ({
  radar: { getState: async () => ({ config: { enabled: radar } }) },
  engagement: { getState: async () => ({ config: { enabled: engagement } }) },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rearmFeatureAlarms", () => {
  it("brings back the alarms of enabled features that have lost theirs", async () => {
    vi.useFakeTimers({ now: NOW });
    const alarms = fakeAlarms();

    await rearmFeatureAlarms({ ...features(true, true), clock: new ChromeAlarms() });

    expect(alarms.get(ALARM_RADAR)).toBe(NOW + RADAR_INTERVAL_MS);
    expect(alarms.get(ALARM_ENGAGEMENT)).toBe(NOW + TICK_INTERVAL_MS);
  });

  it("leaves an alarm that still exists alone, so its schedule is not pushed back", async () => {
    vi.useFakeTimers({ now: NOW + 5000 });
    const alarms = fakeAlarms([ALARM_RADAR, ALARM_ENGAGEMENT]);

    await rearmFeatureAlarms({ ...features(true, true), clock: new ChromeAlarms() });

    expect(alarms.get(ALARM_RADAR)).toBe(NOW);
    expect(alarms.get(ALARM_ENGAGEMENT)).toBe(NOW);
  });

  it("does not create alarms for features that are off", async () => {
    const alarms = fakeAlarms();
    await rearmFeatureAlarms({ ...features(false, false), clock: new ChromeAlarms() });
    expect(alarms.size).toBe(0);
  });

  it("handles each feature on its own", async () => {
    vi.useFakeTimers({ now: NOW });
    const alarms = fakeAlarms([ALARM_RADAR]);

    await rearmFeatureAlarms({ ...features(true, true), clock: new ChromeAlarms() });

    expect(alarms.get(ALARM_RADAR)).toBe(NOW);
    expect(alarms.has(ALARM_ENGAGEMENT)).toBe(true);
  });

  it("never throws: a feature whose state cannot be read must not stop startup", async () => {
    const alarms = fakeAlarms();
    vi.useFakeTimers({ now: NOW });
    await expect(
      rearmFeatureAlarms({
        radar: {
          getState: async () => {
            throw new Error("storage unavailable");
          },
        },
        engagement: { getState: async () => ({ config: { enabled: true } }) },
        clock: new ChromeAlarms(),
      }),
    ).resolves.toBeUndefined();
    expect(alarms.has(ALARM_ENGAGEMENT)).toBe(true);
  });
});
