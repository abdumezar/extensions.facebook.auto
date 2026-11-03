import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DocIdRow } from "@nashir/shared";
import { LogsPage } from "./LogsPage.js";
import { loadDocIds } from "../lib/data.js";

vi.mock("../lib/data.js", () => ({ loadDocIds: vi.fn() }));
vi.mock("../lib/rpc.js", () => ({ call: vi.fn(() => Promise.reject(new Error("no governor"))) }));

/**
 * Translations are absent under test, so react-i18next echoes the key. The Logs page
 * is where the operations card lives; what matters here is WHEN the card shows and
 * when it re-reads, not how the card looks (that is DocIdStatusCard.test.tsx).
 */

type Listener = (changes: Record<string, chrome.storage.StorageChange>) => void;

const BUNDLED_ID = "2222222222222222";
const LEARNED_ID = "9999999999999999";

const ROWS: DocIdRow[] = [
  { name: "CommentListComponentsRootQuery", active: BUNDLED_ID, source: "bundled" },
];
const LEARNED: DocIdRow[] = [
  { name: "CommentListComponentsRootQuery", active: LEARNED_ID, source: "learned", seenAt: 1_800_000_000_000 },
];

const added: Listener[] = [];
const removed: Listener[] = [];
const load = vi.mocked(loadDocIds);

/** Delivers a storage change to every listener the page has registered. */
function storageChanged(key: string) {
  act(() => {
    for (const l of added) l({ [key]: { newValue: [] } });
  });
}

beforeEach(() => {
  added.length = 0;
  removed.length = 0;
  load.mockReset();
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: {
        addListener: (l: Listener) => added.push(l),
        removeListener: (l: Listener) => removed.push(l),
      },
    },
  });
});

afterEach(() => {
  // Unmount while `chrome` still exists: the page removes its listeners on the way out.
  cleanup();
  vi.unstubAllGlobals();
});

describe("LogsPage operations card", () => {
  it("stays hidden while the list is empty", async () => {
    load.mockResolvedValue([]);
    render(<LogsPage />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByText("docIds.title")).not.toBeInTheDocument();
  });

  it("shows once rows arrive, and re-reads when the stored ids change", async () => {
    load.mockResolvedValueOnce(ROWS).mockResolvedValueOnce(LEARNED);
    render(<LogsPage />);

    expect(await screen.findByText(BUNDLED_ID)).toBeInTheDocument();

    storageChanged("nashir:docIds");
    expect(await screen.findByText(LEARNED_ID)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores changes to other storage keys", async () => {
    load.mockResolvedValue(ROWS);
    render(<LogsPage />);
    await screen.findByText(BUNDLED_ID);

    storageChanged("nashir:logs");
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good rows when a re-read fails", async () => {
    load.mockResolvedValueOnce(ROWS).mockResolvedValueOnce(null);
    render(<LogsPage />);
    await screen.findByText(BUNDLED_ID);

    storageChanged("nashir:docIds");
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByText(BUNDLED_ID)).toBeInTheDocument();
  });

  it("drops a slow reply that a newer read has already overtaken", async () => {
    let releaseSlow!: (rows: DocIdRow[]) => void;
    load
      .mockReturnValueOnce(new Promise<DocIdRow[]>((resolve) => (releaseSlow = resolve)))
      .mockResolvedValueOnce(LEARNED);
    render(<LogsPage />);

    storageChanged("nashir:docIds");
    expect(await screen.findByText(LEARNED_ID)).toBeInTheDocument();

    await act(async () => releaseSlow(ROWS));
    expect(screen.getByText(LEARNED_ID)).toBeInTheDocument();
    expect(screen.queryByText(BUNDLED_ID)).not.toBeInTheDocument();
  });

  it("stops listening when the page goes away", async () => {
    load.mockResolvedValue(ROWS);
    const { unmount } = render(<LogsPage />);
    await screen.findByText(BUNDLED_ID);

    unmount();

    // Every listener the page registered is one it removed.
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toHaveLength(added.length);
    expect(removed).toEqual(expect.arrayContaining(added));
  });

  it("does not update after unmount when a read is still in flight", async () => {
    let release!: (rows: DocIdRow[]) => void;
    load.mockReturnValueOnce(new Promise<DocIdRow[]>((resolve) => (release = resolve)));
    const { unmount } = render(<LogsPage />);

    unmount();
    await act(async () => release(ROWS));

    expect(screen.queryByText("docIds.title")).not.toBeInTheDocument();
  });
});
