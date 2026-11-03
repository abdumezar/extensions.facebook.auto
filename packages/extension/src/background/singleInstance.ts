/**
 * singleInstance — the dashboard is a full extension page opened as its own tab.
 * Opening the action focuses the existing dashboard tab, or creates one, and closes
 * any stray duplicates so campaign state never has two conflicting controllers.
 */

const DASHBOARD_PATH = "src/dashboard/index.html";

function dashboardUrl(): string {
  return chrome.runtime.getURL(DASHBOARD_PATH);
}

export async function openOrFocusDashboard(): Promise<void> {
  const url = dashboardUrl();
  const tabs = await chrome.tabs.query({ url });
  const [first, ...rest] = tabs;

  // Close duplicates.
  const dupeIds = rest.map((t) => t.id).filter((id): id is number => id != null);
  if (dupeIds.length) await chrome.tabs.remove(dupeIds);

  if (first?.id != null) {
    await chrome.tabs.update(first.id, { active: true });
    if (first.windowId != null) await chrome.windows.update(first.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
