import type { UpdateState } from "@nashir/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version as PACKAGE_VERSION } from "../../../package.json";
import { en } from "../i18n/en.js";
import { UPDATE_STORAGE_KEY } from "../../update/UpdateService.js";
import { UpdateBanner } from "./UpdateBanner.js";

const rpc = vi.fn();
vi.mock("../lib/rpc.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
  call: (...args: unknown[]) => rpc(...args),
}));

const runSelfUpdate = vi.fn();
const linkFolder = vi.fn();
vi.mock("../lib/selfUpdate.js", () => ({
  runSelfUpdate: (...args: unknown[]) => runSelfUpdate(...args),
  linkFolder: (...args: unknown[]) => linkFolder(...args),
}));

/** The real English strings, so assertions read as the user would see them. */
function withEnglish(ui: React.ReactElement) {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;
}

const available = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: "available",
  current: PACKAGE_VERSION,
  checkedAt: 1,
  latest: { version: "1.0.1", notesUrl: "https://notes.test/v1.0.1", zipUrl: "https://dl.test/z.zip", sigUrl: "https://dl.test/z.sig" },
  ...over,
});

function answer(state: UpdateState) {
  rpc.mockImplementation(async (req: { type: string }) =>
    req.type === "GET_UPDATE_STATE" ? { ok: true, data: state } : { ok: true },
  );
}

/** A stand-in for chrome.storage.onChanged that tests can fire. */
function stubStorageEvents() {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  vi.stubGlobal("chrome", {
    storage: {
      onChanged: {
        addListener: (fn: never) => listeners.add(fn),
        removeListener: (fn: never) => listeners.delete(fn),
      },
    },
  });
  return {
    listeners,
    fire: (changes: Record<string, unknown>, area = "local") => act(() => listeners.forEach((fn) => fn(changes, area))),
  };
}

beforeEach(() => window.history.replaceState({}, "", "/"));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdateBanner", () => {
  it("shows version and calls runSelfUpdate", async () => {
    const state = available();
    answer(state);
    runSelfUpdate.mockResolvedValue("reloading");
    render(withEnglish(<UpdateBanner />));

    expect(await screen.findByText("Version 1.0.1 is available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /what's new/i })).toHaveAttribute("href", "https://notes.test/v1.0.1");

    await userEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(runSelfUpdate).toHaveBeenCalledWith(state);
    expect(await screen.findByText(/Restarting the extension/)).toBeInTheDocument();
    // Nothing more to press once the extension is on its way out.
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  });

  it("shows nothing when there is no update to offer", async () => {
    for (const state of [
      { status: "idle", current: PACKAGE_VERSION },
      { status: "error", current: PACKAGE_VERSION, error: "offline" },
      { status: "available", current: PACKAGE_VERSION },
    ] as UpdateState[]) {
      answer(state);
      const { container, unmount } = render(withEnglish(<UpdateBanner />));
      await waitFor(() => expect(rpc).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
      unmount();
      rpc.mockClear();
    }
  });

  it("keeps offering an update through a failed check", async () => {
    answer(available({ lastCheckFailed: { error: "offline", at: 5 } }));
    render(withEnglish(<UpdateBanner />));
    expect(await screen.findByText("Version 1.0.1 is available")).toBeInTheDocument();
  });

  it("shows \"updated to X\" when opened with ?updatedFrom", async () => {
    window.history.replaceState({}, "", "/?updatedFrom=0.9.0");
    answer({ status: "idle", current: PACKAGE_VERSION });
    render(withEnglish(<UpdateBanner />));

    expect(await screen.findByText(`Updated to version ${PACKAGE_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText("Updated from version 0.9.0.")).toBeInTheDocument();
    // Reloading the page must not announce it again.
    expect(window.location.search).toBe("");
  });

  it("says nothing about an update for a ?updatedFrom that is the running version", async () => {
    window.history.replaceState({}, "", `/?updatedFrom=${PACKAGE_VERSION}`);
    answer({ status: "idle", current: PACKAGE_VERSION });
    const { container } = render(withEnglish(<UpdateBanner />));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("can be dismissed", async () => {
    window.history.replaceState({}, "", "/?updatedFrom=0.9.0");
    answer({ status: "idle", current: PACKAGE_VERSION });
    render(withEnglish(<UpdateBanner />));
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Updated to version/)).not.toBeInTheDocument();
  });

  it("explains a refusal and lets the user try again", async () => {
    answer(available());
    runSelfUpdate.mockResolvedValueOnce({ error: "busy" }).mockResolvedValueOnce("reloading");
    render(withEnglish(<UpdateBanner />));

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByText(en.update.error_busy)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByText(/Restarting the extension/)).toBeInTheDocument();
    expect(screen.queryByText(en.update.error_busy)).not.toBeInTheDocument();
  });

  it("names what is running when the service worker says", async () => {
    answer(available());
    runSelfUpdate.mockResolvedValue({ error: "busy", reason: "groups" });
    render(withEnglish(<UpdateBanner />));
    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByText(en.update.busy_groups)).toBeInTheDocument();
  });

  it("disables the button while the update runs", async () => {
    answer(available());
    let finish!: (value: "reloading") => void;
    runSelfUpdate.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(withEnglish(<UpdateBanner />));

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    finish("reloading");
    await screen.findByText(/Restarting the extension/);
  });

  it("offers to choose the folder when none is linked, then carries on with the update", async () => {
    answer(available());
    runSelfUpdate.mockResolvedValueOnce({ error: "not_linked" }).mockResolvedValueOnce("reloading");
    linkFolder.mockResolvedValue("linked");
    render(withEnglish(<UpdateBanner />));

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByText(en.update.error_not_linked)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: en.update.chooseFolder }));

    expect(linkFolder).toHaveBeenCalledTimes(1);
    expect(runSelfUpdate).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/Restarting the extension/)).toBeInTheDocument();
  });

  it("stays quiet when the folder picker is closed, and explains a wrong folder", async () => {
    answer(available());
    runSelfUpdate.mockResolvedValue({ error: "not_linked" });
    render(withEnglish(<UpdateBanner />));
    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    linkFolder.mockResolvedValueOnce("cancelled");
    await userEvent.click(await screen.findByRole("button", { name: en.update.chooseFolder }));
    expect(runSelfUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.update.error_not_linked)).toBeInTheDocument();

    linkFolder.mockResolvedValueOnce("wrong_folder");
    await userEvent.click(screen.getByRole("button", { name: en.update.chooseFolder }));
    expect(await screen.findByText(en.update.link_wrong_folder)).toBeInTheDocument();
    expect(runSelfUpdate).toHaveBeenCalledTimes(1);
  });

  it("picks up an offer that arrives while the page is open", async () => {
    const events = stubStorageEvents();
    answer({ status: "idle", current: PACKAGE_VERSION, checkedAt: 1 });
    const { container } = render(withEnglish(<UpdateBanner />));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();

    answer(available());
    await events.fire({ [UPDATE_STORAGE_KEY]: { newValue: available() } });

    expect(await screen.findByText("Version 1.0.1 is available")).toBeInTheDocument();
  });

  it("ignores other keys and other storage areas", async () => {
    const events = stubStorageEvents();
    answer({ status: "idle", current: PACKAGE_VERSION, checkedAt: 1 });
    render(withEnglish(<UpdateBanner />));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    await events.fire({ somethingElse: {} });
    await events.fire({ [UPDATE_STORAGE_KEY]: {} }, "sync");

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest answer when two reads finish out of order", async () => {
    const events = stubStorageEvents();
    const replies: Array<(value: unknown) => void> = [];
    rpc.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    render(withEnglish(<UpdateBanner />));
    await waitFor(() => expect(replies).toHaveLength(1));
    await events.fire({ [UPDATE_STORAGE_KEY]: {} });
    await waitFor(() => expect(replies).toHaveLength(2));

    // The second read (an offer) lands first; the first, stale one (idle) lands after it.
    await act(async () => replies[1]!({ ok: true, data: available() }));
    await act(async () => replies[0]!({ ok: true, data: { status: "idle", current: PACKAGE_VERSION } }));

    expect(await screen.findByText("Version 1.0.1 is available")).toBeInTheDocument();
  });

  it("stops listening when it goes away", async () => {
    const events = stubStorageEvents();
    answer({ status: "idle", current: PACKAGE_VERSION });
    const { unmount } = render(withEnglish(<UpdateBanner />));
    await waitFor(() => expect(events.listeners.size).toBe(1));
    unmount();
    expect(events.listeners.size).toBe(0);
  });
});
