import type { UpdateState } from "@nashir/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { version as PACKAGE_VERSION } from "../../../package.json";
import { en } from "../i18n/en.js";
import { formatTimestamp } from "../lib/format.js";
import { UpdatesSection } from "./UpdatesSection.js";

const rpc = vi.fn();
vi.mock("../lib/rpc.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
  call: (...args: unknown[]) => rpc(...args),
}));

const runSelfUpdate = vi.fn();
const linkFolder = vi.fn();
const folderLinked = vi.fn();
vi.mock("../lib/selfUpdate.js", () => ({
  runSelfUpdate: (...args: unknown[]) => runSelfUpdate(...args),
  linkFolder: (...args: unknown[]) => linkFolder(...args),
  folderLinked: (...args: unknown[]) => folderLinked(...args),
}));

function withEnglish(ui: React.ReactElement) {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;
}

const CHECKED_AT = Date.UTC(2026, 10, 3, 9, 30);
const idle: UpdateState = { status: "idle", current: PACKAGE_VERSION, checkedAt: CHECKED_AT };
const offer: UpdateState = {
  status: "available",
  current: PACKAGE_VERSION,
  checkedAt: CHECKED_AT,
  latest: { version: "1.0.1", notesUrl: "https://notes.test/v1.0.1", zipUrl: "https://dl.test/nashir-1.0.1.zip", sigUrl: "https://dl.test/nashir-1.0.1.zip.sig" },
};

/** GET_UPDATE_STATE answers `stored`; CHECK_FOR_UPDATE answers `checked` (default: the same). */
function wire(stored: UpdateState, checked: UpdateState | "fails" = stored, linked = true) {
  folderLinked.mockResolvedValue(linked);
  rpc.mockImplementation(async (req: { type: string }) => {
    if (req.type === "GET_UPDATE_STATE") return { ok: true, data: stored };
    if (req.type === "CHECK_FOR_UPDATE") {
      return checked === "fails" ? { ok: false, error: "no response" } : { ok: true, data: checked };
    }
    return { ok: true };
  });
}

afterEach(() => vi.clearAllMocks());

describe("UpdatesSection", () => {
  it("shows the installed version, when it last checked, and that it is up to date", async () => {
    wire(idle);
    render(withEnglish(<UpdatesSection />));

    expect(await screen.findByText("You have the latest version.")).toBeInTheDocument();
    expect(screen.getByText(PACKAGE_VERSION)).toBeInTheDocument();
    expect(screen.getByText(`Last checked: ${formatTimestamp(CHECKED_AT, "en")}`)).toBeInTheDocument();
  });

  it("says when nothing has been checked yet, and does not claim to be up to date", async () => {
    // Right after an update the stored result is dropped and the first check may be a while off.
    wire({ status: "idle", current: PACKAGE_VERSION });
    render(withEnglish(<UpdatesSection />));
    expect(await screen.findByText("Not checked yet")).toBeInTheDocument();
    expect(screen.queryByText("You have the latest version.")).not.toBeInTheDocument();
  });

  it("check now says it just checked, even when the service worker answers from its stored result", async () => {
    // A check inside the throttle window comes back unchanged, checkedAt included.
    wire(idle);
    render(withEnglish(<UpdatesSection />));
    await screen.findByText("You have the latest version.");

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("Checked just now")).toBeInTheDocument();
    expect(screen.queryByText(/^Last checked:/)).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith({ type: "CHECK_FOR_UPDATE" });
  });

  it("check now shows a newly found release", async () => {
    wire(idle, offer);
    render(withEnglish(<UpdatesSection />));
    await screen.findByText("You have the latest version.");

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("Version 1.0.1 is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
  });

  it("reports a check that could not run", async () => {
    wire(idle, "fails");
    render(withEnglish(<UpdatesSection />));
    await screen.findByText("You have the latest version.");

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(en.update.checkFailedToRun)).toBeInTheDocument();
    expect(screen.queryByText("Checked just now")).not.toBeInTheDocument();
  });

  it("explains an error result in words", async () => {
    wire({ status: "error", current: PACKAGE_VERSION, checkedAt: CHECKED_AT, error: "rate_limited" });
    render(withEnglish(<UpdatesSection />));
    expect(
      await screen.findByText(`The last check did not succeed: ${en.update.reason_rate_limited}`),
    ).toBeInTheDocument();
    expect(screen.queryByText("You have the latest version.")).not.toBeInTheDocument();
  });

  it("notes a failed check next to the last known offer", async () => {
    wire({ ...offer, lastCheckFailed: { error: "offline", at: CHECKED_AT + 1 } });
    render(withEnglish(<UpdatesSection />));

    expect(
      await screen.findByText(`The latest check failed (${en.update.reason_offline}), so this is the last known result.`),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 1.0.1 is available.")).toBeInTheDocument();
  });

  it("links and re-links the folder", async () => {
    wire(idle, idle, false);
    linkFolder.mockResolvedValue("linked");
    render(withEnglish(<UpdatesSection />));

    expect(await screen.findByText("Not linked yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Link folder" }));

    expect(linkFolder).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Linked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link a different folder" })).toBeInTheDocument();
  });

  it("explains a folder that is not the running one, and stays unlinked", async () => {
    wire(idle, idle, false);
    linkFolder.mockResolvedValue("wrong_folder");
    render(withEnglish(<UpdatesSection />));

    await userEvent.click(await screen.findByRole("button", { name: "Link folder" }));

    expect(await screen.findByText(en.update.link_wrong_folder)).toBeInTheDocument();
    expect(screen.getByText("Not linked yet")).toBeInTheDocument();
  });

  it("closing the picker changes nothing", async () => {
    wire(idle, idle, false);
    linkFolder.mockResolvedValue("cancelled");
    render(withEnglish(<UpdatesSection />));

    await userEvent.click(await screen.findByRole("button", { name: "Link folder" }));

    await waitFor(() => expect(linkFolder).toHaveBeenCalled());
    expect(screen.getByText("Not linked yet")).toBeInTheDocument();
    expect(screen.queryByText(en.update.link_wrong_folder)).not.toBeInTheDocument();
    expect(screen.queryByText(en.update.link_failed)).not.toBeInTheDocument();
  });

  it("updates from here too", async () => {
    wire(offer);
    runSelfUpdate.mockResolvedValue("reloading");
    render(withEnglish(<UpdatesSection />));

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    expect(runSelfUpdate).toHaveBeenCalledWith(offer);
    expect(await screen.findByText(/Restarting the extension/)).toBeInTheDocument();
  });

  it("offers the zip for a manual update, with three steps", async () => {
    wire(offer);
    render(withEnglish(<UpdatesSection />));

    const link = await screen.findByRole("link", { name: "Download the zip" });
    expect(link).toHaveAttribute("href", "https://dl.test/nashir-1.0.1.zip");
    expect(screen.getByText("Update by hand")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("explains the manual steps even when nothing is on offer", async () => {
    wire(idle);
    render(withEnglish(<UpdatesSection />));
    await screen.findByText("You have the latest version.");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("link", { name: "Download the zip" })).not.toBeInTheDocument();
  });

  it("always links to the releases page next to the manual steps", async () => {
    wire(idle);
    render(withEnglish(<UpdatesSection />));
    const link = await screen.findByRole("link", { name: "Open the releases page" });
    expect(link).toHaveAttribute("href", "https://github.com/abdumezar/extensions.facebook.auto/releases/latest");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("stops saying it just checked after about a minute", async () => {
    wire(idle);
    render(withEnglish(<UpdatesSection />));
    await screen.findByText("You have the latest version.");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
      expect(await screen.findByText("Checked just now")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });

      expect(screen.queryByText("Checked just now")).not.toBeInTheDocument();
      expect(screen.getByText(`Last checked: ${formatTimestamp(CHECKED_AT, "en")}`)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
