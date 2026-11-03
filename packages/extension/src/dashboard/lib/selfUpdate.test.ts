import { describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { strToU8, zipSync } from "fflate";
import type { BusyReason, UpdateState } from "@nashir/shared";
import { MemoryDirectory } from "../../update/MemoryDirectory.js";
import { NotRunningFolderError } from "../../platform/FsAccessDirectory.js";
import { EXTENSION_KEY } from "../../update/extensionKey.js";
import { MAX_ZIP_BYTES, defaultDeps, folderLinked, linkFolder, runSelfUpdate, type SelfUpdateDeps } from "./selfUpdate.js";

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const byName = (a: string, b: string) => (a < b ? -1 : 1);

const ZIP_URL = "https://downloads.test/nashir-1.0.1.zip";
const SIG_URL = "https://downloads.test/nashir-1.0.1.zip.sig";
const KEY = "pinned-extension-key";

const secret = ed.utils.randomPrivateKey();
const publicB64 = toBase64(await ed.getPublicKeyAsync(secret));

/** A release archive as the packer writes it: the entries plus a manifest and a file list. */
function releaseZip(
  entries: Record<string, string>,
  manifest: Record<string, unknown> = { version: "1.0.1", key: KEY },
): Uint8Array {
  const all: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest)) };
  for (const [name, text] of Object.entries(entries)) all[name] = strToU8(text);
  const names = [...Object.keys(all), "nashir-files.json"].sort(byName);
  all["nashir-files.json"] = strToU8(JSON.stringify(names));
  return zipSync(all);
}

async function sign(zip: Uint8Array, key = secret): Promise<string> {
  return toBase64(await ed.signAsync(zip, key));
}

const available = (over: Partial<NonNullable<UpdateState["latest"]>> = {}): UpdateState => ({
  status: "available",
  current: "1.0.0",
  latest: { version: "1.0.1", notesUrl: "https://notes.test/v1.0.1", zipUrl: ZIP_URL, sigUrl: SIG_URL, ...over },
});

const INSTALLED = {
  "manifest.json": JSON.stringify({ version: "1.0.0", key: KEY }),
  "app.js": "old app",
  "old-only.js": "dropped by the new release",
  "nashir-files.json": JSON.stringify(["app.js", "manifest.json", "nashir-files.json", "old-only.js"]),
  "notes.txt": "a file the user keeps here",
};

interface Setup {
  zip?: Uint8Array;
  sig?: string | Promise<string>;
  /** Answers of consecutive busy checks; the last one repeats. */
  busy?: boolean | "throws" | BusyReason | Array<boolean | BusyReason>;
  folder?: "none" | "stale" | "ok";
  permission?: boolean;
  running?: { version: string; key: string };
  installed?: Record<string, string>;
  respond?: (url: string) => Response | Promise<Response>;
}

async function harness(setup: Setup = {}) {
  const zip =
    setup.zip ?? releaseZip({ "app.js": "new app", "popup/index.html": "<html>", "assets/chunk.js": "chunk" });
  const sig = await (setup.sig ?? sign(zip));
  const dir = new MemoryDirectory(setup.installed ?? INSTALLED);
  const handle = {} as FileSystemDirectoryHandle;
  const folder = setup.folder ?? "ok";

  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const target = String(url);
    if (setup.respond) return setup.respond(target);
    if (target === ZIP_URL) return new Response(zip.slice());
    if (target === SIG_URL) return new Response(sig);
    return new Response("not found", { status: 404 });
  });
  const reload = vi.fn();
  const clearFolder = vi.fn(async () => {});
  const probe = vi.fn(async () => folder === "ok");
  const ensurePermission = vi.fn(async () => setup.permission ?? true);
  const loadFolder = vi.fn(async () => (folder === "none" ? null : handle));
  let busyCalls = 0;
  const isBusy = vi.fn(async () => {
    if (setup.busy === "throws") throw new Error("service worker unreachable");
    if (Array.isArray(setup.busy)) return setup.busy[Math.min(busyCalls++, setup.busy.length - 1)]!;
    return setup.busy ?? false;
  });

  const deps: SelfUpdateDeps = {
    isBusy,
    loadFolder,
    ensurePermission,
    probe,
    clearFolder,
    fetch: fetchMock as unknown as typeof fetch,
    publicKeys: [publicB64],
    directory: () => dir,
    runningVersion: () => setup.running?.version ?? "1.0.0",
    runningKey: () => setup.running?.key ?? KEY,
    reload,
  };
  return { deps, dir, reload, clearFolder, probe, ensurePermission, loadFolder, isBusy, fetchMock };
}

describe("runSelfUpdate", () => {
  it("refuses while a campaign is running", async () => {
    const h = await harness({ busy: true });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "busy" });

    // Nothing was even looked at: no folder, no download.
    expect(h.loadFolder).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("says what is running when the check names it", async () => {
    const h = await harness({ busy: "extraction" });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "busy", reason: "extraction" });
    expect(h.dir.ops).toEqual([]);
  });

  it("checks again right before writing, after the slow steps, and aborts if something started", async () => {
    // Free for the first look, then a job begins while the archive downloads.
    const h = await harness({ busy: [false, "groups"] });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "busy", reason: "groups" });

    expect(h.isBusy).toHaveBeenCalledTimes(2);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("treats an unanswered busy check as busy", async () => {
    const h = await harness({ busy: "throws" });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "busy" });
    expect(h.dir.ops).toEqual([]);
  });

  it("needs a state that offers an update", async () => {
    const h = await harness();
    expect(await runSelfUpdate({ status: "idle", current: "1.0.0" }, h.deps)).toEqual({ error: "download_failed" });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a folder when none is linked", async () => {
    const h = await harness({ folder: "none" });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "not_linked" });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("stops when write permission is refused, before probing or downloading", async () => {
    const h = await harness({ permission: false });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "permission_denied" });
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.dir.ops).toEqual([]);
  });

  it("a permission request that throws keeps the link", async () => {
    // Chrome throws a SecurityError when the click's user activation has run out.
    const h = await harness();
    h.deps.ensurePermission = async () => {
      throw new DOMException("User activation is required.", "SecurityError");
    };

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "permission_denied" });

    expect(h.clearFolder).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.dir.ops).toEqual([]);
  });

  it("a probe that throws is a stale link too", async () => {
    const h = await harness();
    h.deps.probe = async () => {
      throw new DOMException("The folder is gone.", "NotFoundError");
    };

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "not_linked" });

    expect(h.clearFolder).toHaveBeenCalledTimes(1);
    expect(h.dir.ops).toEqual([]);
  });

  it("two presses at once run one update", async () => {
    // The banner and the Settings card can both be on screen; two runs over one folder
    // would interleave their snapshots and their rollbacks.
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.deps.isBusy = async () => {
      await gate;
      return false;
    };

    const first = runSelfUpdate(available(), h.deps);
    const second = runSelfUpdate(available(), h.deps);
    release();

    expect(await Promise.all([first, second])).toEqual(["reloading", "reloading"]);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows another update once the first has finished", async () => {
    const h = await harness({ folder: "none" });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "not_linked" });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "not_linked" });
    expect(h.loadFolder).toHaveBeenCalledTimes(2);
  });

  it("re-probes before writing; stale handle is cleared", async () => {
    const h = await harness({ folder: "stale" });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "not_linked" });

    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.clearFolder).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("downloads without cookies", async () => {
    const h = await harness();
    await runSelfUpdate(available(), h.deps);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of h.fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", cache: "no-store" });
    }
  });

  it.each([
    ["a missing zip", (url: string) => (url === ZIP_URL ? new Response("", { status: 404 }) : new Response("sig"))],
    ["a missing signature", (url: string) => (url === SIG_URL ? new Response("", { status: 404 }) : new Response("zip"))],
  ])("reports %s as a failed download and writes nothing", async (_name, respond) => {
    const h = await harness({ respond });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "download_failed" });
    expect(h.dir.ops).toEqual([]);
  });

  it("reports a network failure as a failed download", async () => {
    const h = await harness({
      respond: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "download_failed" });
    expect(h.dir.ops).toEqual([]);
  });

  it("refuses an archive that announces more than 50 MB without reading it", async () => {
    const pull = vi.fn();
    const h = await harness({
      respond: (url) =>
        url === ZIP_URL
          ? new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { "content-length": String(MAX_ZIP_BYTES + 1) } })
          : new Response("sig"),
    });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "too_large" });
    expect(pull).not.toHaveBeenCalled();
    expect(h.dir.ops).toEqual([]);
  });

  it("refuses an archive that turns out larger than 50 MB whatever it announced", async () => {
    const chunk = new Uint8Array(20 * 1024 * 1024);
    let sent = 0;
    const h = await harness({
      respond: (url) =>
        url === ZIP_URL
          ? new Response(
              new ReadableStream({
                pull(controller) {
                  if (sent++ < 10) controller.enqueue(chunk);
                  else controller.close();
                },
              }),
            )
          : new Response("sig"),
    });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "too_large" });
    // It gave up at the limit rather than reading all of it.
    expect(sent).toBeLessThan(10);
    expect(h.dir.ops).toEqual([]);
  });

  it("bad signature never touches the folder", async () => {
    const zip = releaseZip({ "app.js": "tampered" });
    const stranger = ed.utils.randomPrivateKey();
    const h = await harness({ zip, sig: sign(zip, stranger) });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "bad_signature" });

    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("a signature over different bytes is a bad signature", async () => {
    const h = await harness({ sig: sign(releaseZip({ "app.js": "something else" })) });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "bad_signature" });
    expect(h.dir.ops).toEqual([]);
  });

  it("unsafe archive never touches the folder", async () => {
    // Genuinely signed, so the signature check passes and only the paths are wrong.
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ version: "1.0.1", key: KEY })),
      "../outside.js": strToU8("escapes the folder"),
      "nashir-files.json": strToU8(JSON.stringify(["../outside.js", "manifest.json", "nashir-files.json"])),
    });
    const h = await harness({ zip });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "unsafe_archive" });

    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("a signed file that is not a zip is an unsafe archive", async () => {
    const h = await harness({ zip: strToU8("definitely not a zip") });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "unsafe_archive" });
    expect(h.dir.ops).toEqual([]);
  });

  it("older signed zip under a newer tag is refused", async () => {
    // The tag and the state say 1.0.1; the signed archive inside is the 1.0.0 release.
    const h = await harness({ zip: releaseZip({ "app.js": "old build" }, { version: "1.0.0", key: KEY }) });

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "version_mismatch" });

    expect(h.dir.ops).toEqual([]);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("refuses a release that is not newer than the running version", async () => {
    const h = await harness({ running: { version: "1.0.1", key: KEY } });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "version_mismatch" });
    expect(h.dir.ops).toEqual([]);
  });

  it("a zip with a different manifest key is refused", async () => {
    const h = await harness({ zip: releaseZip({ "app.js": "x" }, { version: "1.0.1", key: "some-other-key" }) });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "version_mismatch" });
    expect(h.dir.ops).toEqual([]);
  });

  it("a signed zip without a key is refused", async () => {
    const h = await harness({ zip: releaseZip({ "app.js": "x" }, { version: "1.0.1" }) });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "version_mismatch" });
    expect(h.dir.ops).toEqual([]);
  });

  it("no key on either side is not a match", async () => {
    const h = await harness({
      zip: releaseZip({ "app.js": "x" }, { version: "1.0.1" }),
      running: { version: "1.0.0", key: "" },
    });
    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "version_mismatch" });
    expect(h.dir.ops).toEqual([]);

    const empty = await harness({
      zip: releaseZip({ "app.js": "x" }, { version: "1.0.1", key: "" }),
      running: { version: "1.0.0", key: "" },
    });
    expect(await runSelfUpdate(available(), empty.deps)).toEqual({ error: "version_mismatch" });
    expect(empty.dir.ops).toEqual([]);
  });

  it("compares against the key compiled into the extension, not what the runtime reports", () => {
    expect(defaultDeps().runningKey()).toBe(EXTENSION_KEY);
    expect(EXTENSION_KEY.length).toBeGreaterThan(100);
  });

  it("happy path writes then reloads", async () => {
    const h = await harness();

    expect(await runSelfUpdate(available(), h.deps)).toBe("reloading");

    expect(h.dir.snapshot()).toEqual({
      "manifest.json": JSON.stringify({ version: "1.0.1", key: KEY }),
      "app.js": "new app",
      "popup/index.html": "<html>",
      "assets/chunk.js": "chunk",
      "nashir-files.json": JSON.stringify([
        "app.js",
        "assets/chunk.js",
        "manifest.json",
        "nashir-files.json",
        "popup/index.html",
      ]),
      // Not the release's, so not touched.
      "notes.txt": "a file the user keeps here",
    });
    // The manifest is what makes Chrome use the new files, so it goes last of the writes.
    const writes = h.dir.ops.filter((op) => op.startsWith("write:"));
    expect(writes.at(-1)).toBe("write:manifest.json");
    expect(writes.at(-2)).toBe("write:nashir-files.json");
    // The previous release's file that this one dropped is removed.
    expect(h.dir.ops).toContain("delete:old-only.js");
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("updates a folder that has no file list from the previous release", async () => {
    const withoutList: Record<string, string> = { ...INSTALLED };
    delete withoutList["nashir-files.json"];
    const h = await harness({ installed: withoutList });

    expect(await runSelfUpdate(available(), h.deps)).toBe("reloading");

    // Without the old list nothing can be called stale, so nothing is deleted.
    expect(h.dir.deletes).toEqual([]);
    expect(h.dir.snapshot()["old-only.js"]).toBe("dropped by the new release");
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("treats a damaged file list in the folder as no list", async () => {
    const h = await harness({ installed: { ...INSTALLED, "nashir-files.json": "{not json" } });
    expect(await runSelfUpdate(available(), h.deps)).toBe("reloading");
    expect(h.dir.deletes).toEqual([]);
  });

  it("reloads even when removing a stale file fails", async () => {
    const h = await harness();
    const dir = h.dir;
    h.deps.directory = () => ({
      exists: (path) => dir.exists(path),
      readFile: (path) => dir.readFile(path),
      writeFile: (path, data) => dir.writeFile(path, data),
      deleteFile: async () => {
        throw new Error("file is locked");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await runSelfUpdate(available(), h.deps)).toBe("reloading");
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("a failed write is reported, restored, and does not reload", async () => {
    const h = await harness();
    h.dir.failOnWrite(2);

    expect(await runSelfUpdate(available(), h.deps)).toEqual({ error: "write_failed" });

    expect(h.dir.snapshot()).toEqual(INSTALLED);
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe("linkFolder", () => {
  const handle = {} as FileSystemDirectoryHandle;

  it("links the folder once it is proven to be the running one", async () => {
    expect(await linkFolder(async () => handle)).toBe("linked");
  });

  it("treats closing the picker as a quiet cancel", async () => {
    expect(
      await linkFolder(async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      }),
    ).toBe("cancelled");
  });

  it("says so when the folder is not the one Chrome runs", async () => {
    expect(
      await linkFolder(async () => {
        throw new NotRunningFolderError();
      }),
    ).toBe("wrong_folder");
  });

  it("reports anything else as a failure", async () => {
    expect(
      await linkFolder(async () => {
        throw new Error("disk on fire");
      }),
    ).toBe("failed");
  });
});

describe("folderLinked", () => {
  it("is true when a folder is remembered", async () => {
    expect(await folderLinked(async () => ({}) as FileSystemDirectoryHandle)).toBe(true);
  });

  it("is false when none is, or when the store cannot be read", async () => {
    expect(await folderLinked(async () => null)).toBe(false);
    expect(
      await folderLinked(async () => {
        throw new Error("no IndexedDB");
      }),
    ).toBe(false);
  });
});
