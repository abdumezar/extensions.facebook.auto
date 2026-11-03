import { CURRENT_SESSION } from "@nashir/shared";
import { installDnrRules } from "./dnrManager.js";
import { handleUiRequest, openOrFocusDashboard } from "./messageRouter.js";
import { container } from "./container.js";
import { ALARM_TICK } from "../engine/CampaignEngine.js";
import { ALARM_RAMP } from "../engine/FeasibilityRunner.js";
import { ALARM_ENGAGEMENT } from "../engine/EngagementService.js";
import { ALARM_RADAR } from "../engine/LeadRadarService.js";
import { ALARM_GROUPS_RESUME } from "../engine/GroupSyncService.js";
import { isFacebookPage } from "../engine/DocIdHarvester.js";
import { measuredDefaults } from "../engine/feasibilityMath.js";
import { ALARM_UPDATE_CHECK, UPDATE_CHECK_PERIOD_MINUTES } from "../update/UpdateService.js";
import { shouldAnnounceUpdate } from "../update/announce.js";
import { e2eBuild } from "../update/e2e.js";
import { rearmFeatureAlarms } from "./rearm.js";
import { injectContentScriptIntoTabs } from "../platform/ChromeTabs.js";

/**
 * Service worker entry point. Wires lifecycle, the alarm-driven campaign loop, and the
 * typed message router. Everything durable lives in persisted RunState, so the SW can
 * be evicted between ticks without losing a run.
 */

async function bootstrap(): Promise<void> {
  if (e2eBuild) {
    container().logger.warn("End-to-end test build: releases come from a local address", { build: e2eBuild.marker });
  }
  // First, and on its own: a failure further down must not leave the service worker without its
  // update beat.
  try {
    await ensureUpdateAlarm();
  } catch (err) {
    container().logger.warn("Could not schedule the update check", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Never throws, and nothing waits on it: a slow or unreachable GitHub must not hold
  // up the rest of startup.
  void container().updates.check();
  await installDnrRules();
  // If a run was mid-flight when the SW was evicted, make sure its alarm exists.
  const state = await container().engine.getState();
  // A cooled-down run is deliberately NOT re-armed. Facebook asked us to stop, and
  // walking back in unattended the moment a timer expires is how a short throttle
  // becomes a restricted account — the operator resumes it.
  if (state && (state.status === "running" || state.status === "safety_break")) {
    await chrome.alarms.create(ALARM_TICK, { when: Math.max(state.nextWakeAt, Date.now() + 1000) });
  }
  // Same for a rate ramp: it posts for real, so a lost alarm must not leave it half-run.
  const record = await container().feasibility.get();
  if (record.ramp?.status === "running") {
    await chrome.alarms.create(ALARM_RAMP, {
      when: Math.max(record.ramp.nextWakeAt ?? 0, Date.now() + 1000),
    });
  }
  // Alarms can be dropped when an update replaces the files; a switched-on feature
  // with no alarm would otherwise never wake again.
  await rearmFeatureAlarms({
    radar: container().radar,
    engagement: container().engagement,
    clock: container().clock,
  });
  // Budget limits come from the bundled recipe, narrowed again by whatever the rate
  // ramp measured on this install.
  container().governor.applyBudget((await container().getRecipe()).callBudget);
  container().governor.applyMeasured(measuredCeiling(record));

  await container().groupSync.syncIfStale();
  // If Facebook happens to be open at startup, take the free read of who is logged in.
  void container().session.refreshProfileIfPossible();
}

/**
 * The slow, unattended "is there a newer release" beat. Created only when absent:
 * re-creating an alarm restarts its period, and a service worker that wakes often would
 * otherwise keep pushing the next check away.
 */
async function ensureUpdateAlarm(): Promise<void> {
  if (await chrome.alarms.get(ALARM_UPDATE_CHECK)) return;
  await chrome.alarms.create(ALARM_UPDATE_CHECK, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES });
}

/**
 * Opens the dashboard on `?updatedFrom=<previous>` so it can say what changed. Reuses a
 * dashboard tab that is already open rather than adding a second one.
 */
async function openDashboardAfterUpdate(previousVersion: string): Promise<void> {
  const base = chrome.runtime.getURL("src/dashboard/index.html");
  const url = `${base}?updatedFrom=${encodeURIComponent(previousVersion)}`;
  const [existing] = await chrome.tabs.query({ url: `${base}*` });
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/**
 * The safe call rate the rate ramp established, if it ever ran to a conclusion.
 * `ceilingPostsPerHour` is the last tier that held; `measuredDefaults` derates it.
 */
function measuredCeiling(record: { ramp?: { ceilingPostsPerHour?: number } }) {
  const ceiling = record.ramp?.ceilingPostsPerHour;
  return ceiling ? measuredDefaults(ceiling) : null;
}

/**
 * Chrome does not inject a manifest content script into tabs that were open before the
 * extension was installed or reloaded, so on the first run the Facebook tabs the user
 * already has are deaf. Give them the script, and only then read the profile, so the
 * first dashboard open already knows the name and photo.
 */
async function prepareOpenFacebookTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
    await injectContentScriptIntoTabs(tabs.flatMap((t) => (t.id != null ? [t.id] : [])));
  } catch (err) {
    container().logger.warn("Could not prepare open Facebook tabs", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await container().session.refreshProfileIfPossible();
}

chrome.runtime.onInstalled.addListener((details) => {
  void bootstrap();
  void prepareOpenFacebookTabs();
  if (shouldAnnounceUpdate(details, chrome.runtime.getManifest().version)) {
    void openDashboardAfterUpdate(details.previousVersion);
  }
});
chrome.runtime.onStartup.addListener(() => void bootstrap());

/**
 * The moment a Facebook page finishes loading, session tokens are free to obtain — no
 * tab to open, no cookie swap, nothing for the user to notice. That is the cheapest
 * possible time to refresh the group cache, so we take it (throttled inside GroupSync).
 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url?.includes("facebook.com")) return;
  void container().groupSync.syncIfStale();
  // The same free moment is when the viewer's name and avatar are readable. Scraping
  // them here is a message to a content script on a page that is already open: no tab
  // opened, no Facebook request, nothing spent from the call budget. It is what makes
  // the dashboard know who you are before you have opened Facebook in this session.
  void container().session.refreshProfileIfPossible();
  // And the moment to see which doc_ids Facebook's own code is using right now. Reads
  // the page that is already open; throttled per tab inside the harvester.
  if (isFacebookPage(tab.url)) void container().harvester.maybeHarvest(tabId);
});

// Popup / dashboard open request → single-instance dashboard tab.
chrome.action.onClicked.addListener(() => void openOrFocusDashboard());

// Typed RPC from dashboard/popup.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore content-script responses (they have their own shape) and cross-extension msgs.
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "OPEN_DASHBOARD") {
    void openOrFocusDashboard();
    sendResponse({ ok: true });
    return false;
  }
  handleUiRequest(msg).then(sendResponse);
  return true; // async response
});

// The campaign loop heartbeat, plus the rate-ramp's own separate beat.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RAMP) {
    void container().feasibility.rampTick();
    return;
  }
  if (alarm.name === ALARM_UPDATE_CHECK) {
    void container().updates.check();
    return;
  }
  if (alarm.name === ALARM_RADAR) {
    const c = container();
    void c.activity.track("radar", async () => {
      const tokens = await c.scraper.scrapeFromOpenTab();
      const groups = await c.groups.getGroups(CURRENT_SESSION);
      await c.radar.tick(tokens, await c.getRecipe(), new Map(groups.map((g) => [g.id, g])));
    });
    return;
  }
  if (alarm.name === ALARM_GROUPS_RESUME) {
    // Same rules as any background sync: an open logged-in tab or nothing.
    void container().groupSync.syncIfStale();
    return;
  }
  if (alarm.name === ALARM_ENGAGEMENT) {
    // Tokens from a tab the user already has open, never one we open. This is
    // unattended background work: a tab appearing on its own is the opposite of that.
    const c = container();
    void c.activity.track("engagement", () =>
      c.engagement.tick(
        () => c.scraper.scrapeFromOpenTab(),
        () => c.getRecipe(),
      ),
    );
    return;
  }
  if (alarm.name !== ALARM_TICK) return;
  void (async () => {
    const engine = container().engine;
    const state = await engine.getState();
    // A safety-break wake flips the run back to running before ticking.
    if (state?.status === "safety_break" && Date.now() >= state.nextWakeAt) {
      state.status = "running";
      await container().storage.set("nashir:run", state);
    }
    await engine.tick();
  })();
});
