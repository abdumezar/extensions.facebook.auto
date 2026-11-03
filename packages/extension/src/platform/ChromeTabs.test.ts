import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeTabs, injectContentScriptIntoTabs } from "./ChromeTabs.js";

/**
 * A minimal chrome.tabs, enough to exercise the one rule that matters here: we may
 * close a tab we created, and must never close one the user already had.
 */
function stubChrome(opts: { existing?: Array<{ id: number; url: string }> } = {}) {
  const removed: number[] = [];
  const created: Array<{ url?: string; active?: boolean }> = [];
  let nextId = 500;
  const tabs = new Map<number, { id: number; url: string }>();
  for (const t of opts.existing ?? []) tabs.set(t.id, t);

  const listeners: Array<(id: number, info: { status?: string }) => void> = [];

  vi.stubGlobal("chrome", {
    tabs: {
      async get(id: number) {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab with id");
        return t;
      },
      async query() {
        return [...tabs.values()];
      },
      async create(props: { url?: string; active?: boolean }) {
        created.push(props);
        const id = nextId++;
        tabs.set(id, { id, url: props.url ?? "" });
        // A macrotask, not a microtask: ChromeTabs registers its onUpdated listener in
        // the continuation after `await create`, so a microtask would fire first and
        // the wait would hang until its 20s safety timeout.
        setTimeout(() => {
          for (const l of [...listeners]) l(id, { status: "complete" });
        }, 0);
        return { id };
      },
      async remove(id: number) {
        if (!tabs.has(id)) throw new Error("No tab with id");
        tabs.delete(id);
        removed.push(id);
      },
      onUpdated: {
        addListener: (l: (id: number, info: { status?: string }) => void) => void listeners.push(l),
        removeListener: (l: unknown) => {
          const i = listeners.indexOf(l as never);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  });

  return { removed, created, tabs };
}

afterEach(() => vi.unstubAllGlobals());

describe("ensureFacebookTab", () => {
  it("reuses a tab the user already has open", async () => {
    const c = stubChrome({ existing: [{ id: 7, url: "https://www.facebook.com/groups" }] });
    const t = new ChromeTabs();
    expect(await t.ensureFacebookTab()).toBe(7);
    expect(c.created).toEqual([]);
  });

  it("creates one in the background, never focused", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    await t.ensureFacebookTab();
    expect(c.created).toHaveLength(1);
    // `active: false` is the whole difference between a helpful bootstrap and the
    // extension yanking the user's browser to Facebook on open.
    expect(c.created[0]?.active).toBe(false);
  });
});

describe("releaseOwnedTab", () => {
  it("closes the tab we created", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    const id = await t.ensureFacebookTab();
    await t.releaseOwnedTab();
    expect(c.removed).toEqual([id]);
  });

  it("never closes a tab the user already had", async () => {
    // Closing someone's Facebook out from under them is the most obnoxious thing this
    // extension could do, so this is the assertion that matters most in the file.
    const c = stubChrome({ existing: [{ id: 7, url: "https://www.facebook.com/" }] });
    const t = new ChromeTabs();
    await t.ensureFacebookTab();
    await t.releaseOwnedTab();
    expect(c.removed).toEqual([]);
    expect(c.tabs.has(7)).toBe(true);
  });

  it("is a no-op when we never opened one", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    await t.releaseOwnedTab();
    expect(c.removed).toEqual([]);
  });

  it("releases only once", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    await t.ensureFacebookTab();
    await t.releaseOwnedTab();
    await t.releaseOwnedTab();
    expect(c.removed).toHaveLength(1);
  });

  it("survives the tab having been closed by the user already", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    const id = await t.ensureFacebookTab();
    c.tabs.delete(id);
    await expect(t.releaseOwnedTab()).resolves.toBeUndefined();
  });

  it("stops treating a created tab as ours once a user tab supersedes it", async () => {
    const c = stubChrome();
    const t = new ChromeTabs();
    const mine = await t.ensureFacebookTab();
    await t.releaseOwnedTab();
    // Now the user opens their own; a later ensure must adopt it, not own it.
    c.tabs.set(9, { id: 9, url: "https://www.facebook.com/" });
    expect(await t.ensureFacebookTab()).toBe(9);
    await t.releaseOwnedTab();
    expect(c.removed).toEqual([mine]);
  });
});

const CONTENT_FILE = "assets/content.js";
const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

/**
 * chrome.tabs.sendMessage plus chrome.scripting.executeScript, with a scripted run of
 * sendMessage outcomes: a string rejects with that message, anything else resolves.
 */
function stubMessaging(opts: {
  outcomes: Array<string | { ok: boolean; data?: unknown }>;
  manifest?: unknown;
  injectError?: string;
}) {
  const outcomes = [...opts.outcomes];
  const sent: number[] = [];
  const injected: Array<{ target: { tabId: number }; files: string[] }> = [];
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () =>
        "manifest" in opts
          ? opts.manifest
          : { content_scripts: [{ matches: ["*://*.facebook.com/*"], js: [CONTENT_FILE] }] },
    },
    tabs: {
      async sendMessage(tabId: number) {
        sent.push(tabId);
        const next = outcomes.shift();
        if (typeof next === "string") throw new Error(next);
        return next;
      },
    },
    scripting: {
      async executeScript(inj: { target: { tabId: number }; files: string[] }) {
        injected.push(inj);
        if (opts.injectError) throw new Error(opts.injectError);
        return [];
      },
    },
  });
  return { sent, injected };
}

describe("callContent", () => {
  it("injects the content script and retries once when the receiver is missing", async () => {
    // A tab that was already open when the extension was installed or reloaded never
    // got the manifest's content script, so the first message has nobody to hear it.
    const c = stubMessaging({ outcomes: [NO_RECEIVER, { ok: true, data: "tokens" }] });
    const res = await new ChromeTabs().callContent(11, { type: "SCRAPE_TOKENS" });
    expect(res).toEqual({ ok: true, data: "tokens" });
    expect(c.injected).toEqual([{ target: { tabId: 11 }, files: [CONTENT_FILE] }]);
    expect(c.sent).toEqual([11, 11]);
  });

  it("does not inject for other errors", async () => {
    const closed = "The message port closed before a response was received.";
    const c = stubMessaging({ outcomes: [closed] });
    const res = await new ChromeTabs().callContent(11, { type: "SCRAPE_TOKENS" });
    expect(res).toEqual({ ok: false, error: closed });
    expect(c.injected).toEqual([]);
    expect(c.sent).toHaveLength(1);
  });

  it("never retries more than once", async () => {
    const c = stubMessaging({ outcomes: [NO_RECEIVER, NO_RECEIVER, { ok: true }] });
    const res = await new ChromeTabs().callContent(11, { type: "SCRAPE_TOKENS" });
    expect(res).toEqual({ ok: false, error: NO_RECEIVER });
    expect(c.injected).toHaveLength(1);
    expect(c.sent).toHaveLength(2);
  });

  it("returns the original error when the manifest has no content script", async () => {
    const c = stubMessaging({ outcomes: [NO_RECEIVER], manifest: {} });
    const res = await new ChromeTabs().callContent(11, { type: "SCRAPE_TOKENS" });
    expect(res).toEqual({ ok: false, error: NO_RECEIVER });
    expect(c.injected).toEqual([]);
  });

  it("returns the original error, plus why, when injection is rejected", async () => {
    // A discarded tab or an error page cannot be scripted. Keeping both messages is what
    // lets a log tell "no receiver" from "no receiver and could not be scripted".
    const c = stubMessaging({ outcomes: [NO_RECEIVER], injectError: "Cannot access contents of url" });
    const res = await new ChromeTabs().callContent(11, { type: "SCRAPE_TOKENS" });
    expect(res).toEqual({ ok: false, error: `${NO_RECEIVER} (inject: Cannot access contents of url)` });
    expect(c.sent).toHaveLength(1);
  });
});

describe("injectContentScriptIntoTabs", () => {
  it("injects every tab, and one failing tab does not stop the rest", async () => {
    const calls: number[] = [];
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ content_scripts: [{ matches: ["*://*.facebook.com/*"], js: [CONTENT_FILE] }] }),
      },
      scripting: {
        async executeScript(inj: { target: { tabId: number } }) {
          calls.push(inj.target.tabId);
          if (inj.target.tabId === 2) throw new Error("Tab was discarded");
          return [];
        },
      },
    });
    await expect(injectContentScriptIntoTabs([1, 2, 3])).resolves.toBeUndefined();
    expect(calls).toEqual([1, 2, 3]);
  });

  it("does nothing when the manifest has no content script", async () => {
    const c = stubMessaging({ outcomes: [], manifest: {} });
    await injectContentScriptIntoTabs([1]);
    expect(c.injected).toEqual([]);
  });
});
