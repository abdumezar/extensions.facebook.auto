import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

/** A chrome.runtime.onMessage with a real add/remove, so "how many listeners" is observable. */
function stubChrome(opts: { removeThrows?: boolean } = {}) {
  const listeners = new Set<Listener>();
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (l: Listener) => void listeners.add(l),
        removeListener: (l: Listener) => {
          if (opts.removeThrows) throw new Error("Extension context invalidated.");
          listeners.delete(l);
        },
      },
    },
  });
  return listeners;
}

async function runContentScript() {
  vi.resetModules();
  await import("./index.js");
}

beforeEach(() => {
  delete (globalThis as { __nashirContent?: unknown }).__nashirContent;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __nashirContent?: unknown }).__nashirContent;
});

describe("content script entry", () => {
  it("registers one listener", async () => {
    const listeners = stubChrome();
    await runContentScript();
    expect(listeners.size).toBe(1);
  });

  it("a second run replaces the previous listener", async () => {
    // Injecting on demand can land on a tab the manifest already covered. Two live
    // listeners would both answer, and the page would see two replies to one question.
    const listeners = stubChrome();
    await runContentScript();
    const first = [...listeners][0];
    await runContentScript();
    expect(listeners.size).toBe(1);
    expect([...listeners][0]).not.toBe(first);
  });

  it("still installs a fresh listener when removing the old one throws", async () => {
    // What an orphan left behind by a reloaded extension looks like: its context is
    // gone, so removal fails, and it must not block the live copy.
    const listeners = stubChrome({ removeThrows: true });
    await runContentScript();
    await runContentScript();
    expect(listeners.size).toBe(2);
    const newest = [...listeners][1]!;
    const reply = vi.fn();
    newest({ type: "READ_C_USER" }, {}, reply);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
