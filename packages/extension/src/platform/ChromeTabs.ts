import type { TabPort } from "../engine/ports/index.js";
import type { ContentRequest, ContentResponse } from "@nashir/shared";

/** What Chrome says when a tab has no content-script listener (substring, case-sensitive). */
const NO_RECEIVER = "Receiving end does not exist";

/** The content script's file as the running manifest names it, or null when it has none. */
function contentScriptFile(): string | null {
  return chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0] ?? null;
}

/** Injects the content script into one tab. Resolves to the failure reason, or null. */
async function injectContentScript(tabId: number, file: string): Promise<string | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Gives each tab the content script and waits for all of them. A tab that cannot be
 * scripted (discarded, still loading, an error page) is skipped; it never throws.
 */
export async function injectContentScriptIntoTabs(tabIds: number[]): Promise<void> {
  const file = contentScriptFile();
  if (!file) return;
  await Promise.all(tabIds.map((id) => injectContentScript(id, file)));
}

/**
 * TabPort backed by chrome.tabs. Owns a dedicated, minimized facebook.com tab used
 * for token scraping / health checks / posting relays. Offscreen documents can't host
 * cross-origin facebook.com, so a real (background) tab is required.
 */
export class ChromeTabs implements TabPort {
  private fbTabId: number | null = null;
  /** Set only when *we* created the tab, so `releaseOwnedTab` never closes the user's. */
  private ownedTabId: number | null = null;

  async ensureFacebookTab(): Promise<number> {
    if (this.fbTabId != null) {
      try {
        const tab = await chrome.tabs.get(this.fbTabId);
        if (tab && tab.url?.includes("facebook.com")) return this.fbTabId;
      } catch {
        this.fbTabId = null;
      }
    }
    // Reuse an existing FB tab if the user has one; otherwise create a background one.
    const existing = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
    if (existing[0]?.id != null) {
      this.fbTabId = existing[0].id;
      // Explicitly not ours: the user opened it, so we must never close it.
      this.ownedTabId = null;
      return this.fbTabId;
    }
    const created = await chrome.tabs.create({ url: "https://www.facebook.com/", active: false });
    this.fbTabId = created.id!;
    this.ownedTabId = created.id!;
    await this.waitForComplete(this.fbTabId);
    return this.fbTabId;
  }

  async findFacebookTab(): Promise<number | null> {
    if (this.fbTabId != null) {
      try {
        const tab = await chrome.tabs.get(this.fbTabId);
        if (tab?.url?.includes("facebook.com")) return this.fbTabId;
      } catch {
        this.fbTabId = null;
      }
    }
    const existing = await chrome.tabs.query({ url: "*://*.facebook.com/*", status: "complete" });
    const id = existing[0]?.id;
    if (id == null) return null;
    this.fbTabId = id;
    return id;
  }

  /**
   * Close the background tab we opened. A no-op when the tab was the user's, or when
   * something else already closed it.
   */
  async releaseOwnedTab(): Promise<void> {
    const id = this.ownedTabId;
    if (id == null) return;
    this.ownedTabId = null;
    if (this.fbTabId === id) this.fbTabId = null;
    try {
      await chrome.tabs.remove(id);
    } catch {
      // Already gone. Nothing to do, and nothing worth telling anyone about.
    }
  }

  async reloadAndWait(tabId: number): Promise<void> {
    await chrome.tabs.reload(tabId);
    await this.waitForComplete(tabId);
    // Give the content script a moment to (re)initialize after load.
    await new Promise((r) => setTimeout(r, 800));
  }

  async callContent<T>(tabId: number, msg: ContentRequest): Promise<ContentResponse<T>> {
    const first = await this.send<T>(tabId, msg);
    if (first.ok || !first.error?.includes(NO_RECEIVER)) return first;

    // Chrome only injects a manifest content script into tabs that load after the
    // extension does. A Facebook tab that was already open when the extension was
    // installed or reloaded has no listener, so give it one and ask again, once.
    const file = contentScriptFile();
    if (!file) return first;
    const injectError = await injectContentScript(tabId, file);
    if (injectError) return { ok: false, error: `${first.error} (inject: ${injectError})` };
    return this.send<T>(tabId, msg);
  }

  private async send<T>(tabId: number, msg: ContentRequest): Promise<ContentResponse<T>> {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, msg)) as ContentResponse<T>;
      return res ?? { ok: false, error: "No response from content script" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private waitForComplete(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      const listener = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Safety timeout so we never hang the loop.
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 20_000);
    });
  }
}
