import { act, cleanup, render, screen } from "@testing-library/react";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@nashir/shared";
import { createTestI18n } from "../../test/i18n.js";
import { useStore } from "../store.js";
import { fetchSession } from "../lib/data.js";
import { DashboardPage } from "./DashboardPage.js";

vi.mock("../lib/data.js", () => ({
  fetchSession: vi.fn(),
  loadSession: vi.fn(),
  reloadGroups: vi.fn(async () => []),
}));

type Listener = (changes: Record<string, chrome.storage.StorageChange>) => void;

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const fetchMock = vi.mocked(fetchSession);
const added: Listener[] = [];
const removed: Listener[] = [];

let i18n: i18n;
let i18nAr: i18n;
beforeAll(async () => {
  i18n = await createTestI18n();
  i18nAr = await createTestI18n("ar");
});

function session(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    loggedIn: true,
    tokensReady: false,
    hasOpenTab: false,
    profile: { fbUserId: "100000000000001", name: "Layla Haddad" },
    profileFresh: false,
    ...over,
  };
}

function setSession(s: SessionStatus | null) {
  act(() => useStore.setState({ session: s }));
}

function renderPage(instance: i18n = i18n) {
  return render(
    <I18nextProvider i18n={instance}>
      <DashboardPage />
    </I18nextProvider>,
  );
}

/** Delivers a storage change to every listener the page registered. */
function storageChanged(key: string) {
  act(() => {
    for (const l of added) l({ [key]: { newValue: {} } });
  });
}

beforeEach(() => {
  added.length = 0;
  removed.length = 0;
  fetchMock.mockReset();
  useStore.setState({ session: null, groups: [] });
  vi.stubGlobal("chrome", {
    storage: {
      onChanged: {
        addListener: (l: Listener) => added.push(l),
        removeListener: (l: Listener) => removed.push(l),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connection card — verified state", () => {
  it("reads Connected and Verified with a recent check and no Facebook tab", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    setSession(session({ verifiedAt: NOW - 4 * MIN }));
    renderPage();

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Verified 4 min ago")).toBeInTheDocument();
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
  });

  it("says Verified just now for a check under a minute old", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    setSession(session({ verifiedAt: NOW - 10_000 }));
    renderPage();
    expect(screen.getByText("Verified just now")).toBeInTheDocument();
  });

  it("reads Not verified, with the remembered note, when there was no recent check", () => {
    setSession(session());
    renderPage();

    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.queryByText(/^Verified /)).not.toBeInTheDocument();
    expect(screen.getByText(/remembered from your last visit/)).toBeInTheDocument();
  });

  it("shows live tokens as Connected without a Verified sub-line", () => {
    setSession(session({ tokensReady: true, hasOpenTab: true, profileFresh: true }));
    renderPage();

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/^Verified /)).not.toBeInTheDocument();
  });

  it("stays Not connected when logged out, even with a stale verifiedAt", () => {
    setSession(session({ loggedIn: false, verifiedAt: NOW }));
    renderPage();

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText(/^Verified /)).not.toBeInTheDocument();
  });

  it("moves the age forward on a 60 second tick", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    setSession(session({ verifiedAt: NOW - 4 * MIN }));
    renderPage();
    expect(screen.getByText("Verified 4 min ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(screen.getByText("Verified 5 min ago")).toBeInTheDocument();
  });

  it("stops ticking after unmount", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    setSession(session({ verifiedAt: Date.now() }));
    const { unmount } = renderPage();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connection card — Arabic relative time", () => {
  // Arabic counts by number class; one fixed "دقيقة" would read "قبل 4 دقيقة".
  it.each([
    [2 * MIN, "قبل دقيقتين"],
    [1 * MIN, "قبل دقيقة"],
    [4 * MIN, "قبل 4 دقائق"],
    [15 * MIN, "قبل 15 دقيقة"],
    [60 * MIN, "قبل ساعة"],
    [2 * 60 * MIN, "قبل ساعتين"],
    [5 * 60 * MIN, "قبل 5 ساعات"],
  ])("renders %i ms ago as %s", (age, ago) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    setSession(session({ verifiedAt: NOW - age }));
    renderPage(i18nAr);
    expect(screen.getByText(`تم التحقق ${ago}`)).toBeInTheDocument();
  });

  it("still reads naturally in English", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    setSession(session({ verifiedAt: NOW - MIN }));
    renderPage();
    expect(screen.getByText("Verified 1 min ago")).toBeInTheDocument();
  });
});

describe("connection card — following storage", () => {
  it("re-reads the session once when a verification lands", async () => {
    fetchMock.mockResolvedValue(session({ verifiedAt: NOW }));
    setSession(session());
    renderPage();

    storageChanged("nashir:verified");
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().session?.verifiedAt).toBe(NOW);
  });

  it("re-reads when the remembered profile changes", async () => {
    fetchMock.mockResolvedValue(session());
    setSession(session());
    renderPage();

    storageChanged("nashir:session:profile");
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-read when the session already has live tokens", async () => {
    setSession(session({ tokensReady: true }));
    renderPage();

    storageChanged("nashir:verified");
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores unrelated storage keys", async () => {
    setSession(session());
    renderPage();

    storageChanged("nashir:logs");
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the current session when the re-read fails", async () => {
    fetchMock.mockResolvedValue(null);
    setSession(session({ verifiedAt: NOW }));
    renderPage();

    storageChanged("nashir:verified");
    await act(async () => {});
    expect(useStore.getState().session?.verifiedAt).toBe(NOW);
  });

  it("drops a slow reply that a newer read has overtaken", async () => {
    let releaseSlow!: (s: SessionStatus) => void;
    fetchMock
      .mockReturnValueOnce(new Promise<SessionStatus>((resolve) => (releaseSlow = resolve)))
      .mockResolvedValueOnce(session({ verifiedAt: 2 }));
    setSession(session());
    renderPage();

    storageChanged("nashir:verified");
    storageChanged("nashir:verified");
    await act(async () => {});
    await act(async () => releaseSlow(session({ verifiedAt: 1 })));

    expect(useStore.getState().session?.verifiedAt).toBe(2);
  });

  it("does not update after unmount when a read is still in flight", async () => {
    let release!: (s: SessionStatus) => void;
    fetchMock.mockReturnValueOnce(new Promise<SessionStatus>((resolve) => (release = resolve)));
    setSession(session());
    const { unmount } = renderPage();

    storageChanged("nashir:verified");
    unmount();
    await act(async () => release(session({ verifiedAt: NOW })));

    expect(useStore.getState().session?.verifiedAt).toBeUndefined();
  });

  it("removes every listener it added", () => {
    setSession(session());
    const { unmount } = renderPage();
    unmount();

    expect(added.length).toBeGreaterThan(0);
    expect(removed).toHaveLength(added.length);
    expect(removed).toEqual(expect.arrayContaining(added));
  });
});
