import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getSavedTheme,
  initTheme,
  resolveTheme,
  setTheme,
  watchSystemTheme,
} from "./theme.js";

/**
 * Installs a controllable `matchMedia`. Returns a trigger that fires the change
 * listeners, so a live OS scheme switch can be simulated.
 */
function stubMatchMedia(prefersDark: boolean) {
  let matches = prefersDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  vi.stubGlobal("matchMedia", (media: string) => ({
    get matches() {
      return matches;
    },
    media,
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));

  return (nowDark: boolean) => {
    matches = nowDark;
    for (const fn of listeners) fn({ matches: nowDark } as MediaQueryListEvent);
  };
}

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("getSavedTheme", () => {
  it("defaults to following the system when nothing is stored", () => {
    expect(getSavedTheme()).toBe("system");
  });

  it("reads back a stored mode", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(getSavedTheme()).toBe("dark");
  });

  it("falls back to system for an unrecognised stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "solarized");
    expect(getSavedTheme()).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("resolves system to dark when the OS prefers dark", () => {
    stubMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
  });

  it("resolves system to light when the OS prefers light", () => {
    stubMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("lets an explicit choice win over the OS preference", () => {
    stubMatchMedia(true);
    expect(resolveTheme("light")).toBe("light");
    stubMatchMedia(false);
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("adds the dark class for dark and removes it for light", () => {
    stubMatchMedia(false);

    applyTheme("dark");
    expect(isDark()).toBe(true);

    applyTheme("light");
    expect(isDark()).toBe(false);
  });

  it("follows the OS when given system", () => {
    stubMatchMedia(true);
    applyTheme("system");
    expect(isDark()).toBe(true);
  });
});

describe("setTheme", () => {
  it("persists the choice and applies it in one step", () => {
    stubMatchMedia(false);

    setTheme("dark");

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(getSavedTheme()).toBe("dark");
    expect(isDark()).toBe(true);
  });

  it("round-trips back to system", () => {
    stubMatchMedia(true);

    setTheme("light");
    expect(isDark()).toBe(false);

    setTheme("system");
    expect(getSavedTheme()).toBe("system");
    expect(isDark()).toBe(true);
  });
});

describe("watchSystemTheme", () => {
  it("repaints when the OS scheme changes while following system", () => {
    const fire = stubMatchMedia(false);
    initTheme();
    expect(isDark()).toBe(false);

    fire(true);
    expect(isDark()).toBe(true);
  });

  it("ignores OS changes once the user has chosen explicitly", () => {
    const fire = stubMatchMedia(false);
    initTheme();

    setTheme("light");
    fire(true);

    expect(isDark()).toBe(false);
  });

  it("stops listening after the returned dispose is called", () => {
    const fire = stubMatchMedia(false);
    const dispose = watchSystemTheme();

    dispose();
    fire(true);

    expect(isDark()).toBe(false);
  });
});
