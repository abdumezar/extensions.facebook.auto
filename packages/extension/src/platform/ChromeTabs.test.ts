import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeTabs } from "./ChromeTabs.js";

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
