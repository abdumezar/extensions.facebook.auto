import { ALARM_ENGAGEMENT, TICK_INTERVAL_MS } from "../engine/EngagementService.js";
import { ALARM_RADAR, RADAR_INTERVAL_MS } from "../engine/LeadRadarService.js";
import type { ClockPort } from "../engine/ports/index.js";

interface Feature {
  getState(): Promise<{ config: { enabled: boolean } }>;
}

/**
 * Puts back the wake-up of a background feature that is switched on but has no alarm.
 *
 * Each of these jobs re-arms itself at the end of a tick, so a lost alarm ends the chain
 * and the feature goes quiet with its switch still on. Alarms can be dropped when the
 * extension's files are replaced and it reloads, which is exactly what an update does.
 * An alarm that exists is left alone, so a service worker that wakes often does not keep
 * pushing the next tick away. Never throws: one feature must not stop startup.
 */
export async function rearmFeatureAlarms(deps: {
  radar: Feature;
  engagement: Feature;
  clock: ClockPort;
}): Promise<void> {
  const jobs: Array<[Feature, string, number]> = [
    [deps.radar, ALARM_RADAR, RADAR_INTERVAL_MS],
    [deps.engagement, ALARM_ENGAGEMENT, TICK_INTERVAL_MS],
  ];
  for (const [feature, alarm, interval] of jobs) {
    try {
      if (!(await feature.getState()).config.enabled) continue;
      if (await chrome.alarms.get(alarm)) continue;
      await deps.clock.scheduleWake(alarm, Date.now() + interval);
    } catch {
      // Best effort; the next start tries again.
    }
  }
}
