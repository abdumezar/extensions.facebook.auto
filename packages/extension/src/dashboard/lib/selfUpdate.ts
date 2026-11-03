import type { BusyReason, BusyState, UpdateState } from "@nashir/shared";
import {
  FsAccessDirectory,
  NotRunningFolderError,
  clearLinkedFolder,
  ensureWritePermission,
  linkExtensionFolder,
  loadLinkedFolder,
  probeFolder,
} from "../../platform/FsAccessDirectory.js";
import { UpdateWriteError, applyUpdate, type DirectoryPort } from "../../update/applyUpdate.js";
import { EXTENSION_KEY } from "../../update/extensionKey.js";
import { RELEASE_PUBLIC_KEYS_B64 } from "../../update/releaseKey.js";
import { isNewerVersion } from "../../update/semver.js";
import { unpackRelease } from "../../update/unpack.js";
import { verifyReleaseSignature } from "../../update/verify.js";
import { appVersion } from "../appVersion.js";
import { rpc } from "./rpc.js";

/** Largest release archive that is downloaded. The shipped one is a few MB. */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** A signature is 64 bytes in base64; this is generous and still tiny. */
const MAX_SIG_BYTES = 4 * 1024;
const FILE_LIST = "nashir-files.json";

export type SelfUpdateError =
  | "busy"
  | "not_linked"
  | "permission_denied"
  | "too_large"
  | "bad_signature"
  | "unsafe_archive"
  | "version_mismatch"
  | "write_failed"
  | "download_failed";

/** `reason` names what is running when the error is `busy`, when the service worker said. */
export type SelfUpdateResult = "reloading" | { error: SelfUpdateError; reason?: BusyReason };

/** Everything the update touches outside this file, so each step can be tested on its own. */
export interface SelfUpdateDeps {
  /** Whether the service worker is in the middle of work a reload would cut short; a string names it. */
  isBusy(): Promise<boolean | BusyReason>;
  loadFolder(): Promise<FileSystemDirectoryHandle | null>;
  ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean>;
  /** Whether the folder is the one Chrome runs this extension from. */
  probe(handle: FileSystemDirectoryHandle): Promise<boolean>;
  clearFolder(): Promise<void>;
  fetch: typeof fetch;
  publicKeys: readonly string[];
  directory(handle: FileSystemDirectoryHandle): DirectoryPort;
  runningVersion(): string;
  /** The key this extension is pinned to; a release has to carry the same one. */
  runningKey(): string;
  reload(): void;
}

/** Built on use, so importing this file touches nothing in `chrome`. */
export function defaultDeps(): SelfUpdateDeps {
  return {
    isBusy: async () => {
      const res = await rpc<BusyState>({ type: "GET_BUSY_STATE" });
      // No answer is not "idle": an update that guesses wrong cuts a run off mid-post.
      if (!res.ok || !res.data) return true;
      return res.data.busy ? (res.data.reason ?? true) : false;
    },
    loadFolder: () => loadLinkedFolder(),
    ensurePermission: ensureWritePermission,
    probe: (handle) => probeFolder(handle),
    clearFolder: () => clearLinkedFolder(),
    fetch: (input, init) => fetch(input, init),
    publicKeys: RELEASE_PUBLIC_KEYS_B64,
    directory: (handle) => new FsAccessDirectory(handle),
    runningVersion: appVersion,
    // The constant the manifest is built from, not what the runtime reports: the check
    // must hold even where the runtime leaves the key out.
    runningKey: () => EXTENSION_KEY,
    reload: () => chrome.runtime.reload(),
  };
}

/** Thrown by `download` for the one failure that has its own message. */
class TooLarge extends Error {}

const REQUEST: RequestInit = { credentials: "omit", cache: "no-store" };

/** The body of `url`, refused as soon as it is known to exceed `max` bytes. */
async function download(fetchFn: typeof fetch, url: string, max: number): Promise<Uint8Array> {
  const res = await fetchFn(url, REQUEST);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > max) {
    await res.body?.cancel().catch(() => {});
    throw new TooLarge();
  }
  // The header can be missing or wrong, so the bytes themselves are counted too.
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) throw new TooLarge();
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The file list the installed release carries, or null when it is absent or damaged. */
async function readInstalledFileList(dir: DirectoryPort): Promise<string[] | null> {
  try {
    const bytes = await dir.readFile(FILE_LIST);
    if (!bytes) return null;
    const list: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(list) && list.every((path) => typeof path === "string") ? (list as string[]) : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<SelfUpdateResult> | null = null;

/**
 * Installs the release `state` offers into the folder the extension runs from, then
 * reloads it. Every check comes before the first write, in this order: nothing running,
 * the folder is still the right one, the download is the right size, the signature holds,
 * the archive is safe, and it really is the newer release of this same extension. A
 * failure at any of those leaves the folder as it was.
 *
 * Only one runs at a time: the banner and the Settings card can both offer the button,
 * and two runs over one folder would interleave their snapshots and their rollbacks. A
 * second call while one is running gets that run's result.
 */
export function runSelfUpdate(state: UpdateState, deps: SelfUpdateDeps = defaultDeps()): Promise<SelfUpdateResult> {
  inFlight ??= update(state, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** `{ error: "busy" }` (with what is running, if known) or null. Unanswered counts as busy. */
async function busyNow(deps: SelfUpdateDeps): Promise<SelfUpdateResult | null> {
  let busy: boolean | BusyReason = true;
  try {
    busy = await deps.isBusy();
  } catch {
    // Unanswered counts as busy.
  }
  if (!busy) return null;
  return typeof busy === "string" ? { error: "busy", reason: busy } : { error: "busy" };
}

async function update(state: UpdateState, deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const latest = state.status === "available" ? state.latest : undefined;
  if (!latest) return { error: "download_failed" };

  // 1. Never reload the extension under a run.
  const busy = await busyNow(deps);
  if (busy) return busy;

  // 2. The folder: linked, writable, and still the one Chrome loads.
  let handle: FileSystemDirectoryHandle | null = null;
  try {
    handle = await deps.loadFolder();
  } catch {
    handle = null;
  }
  if (!handle) return { error: "not_linked" };
  try {
    if (!(await deps.ensurePermission(handle))) return { error: "permission_denied" };
  } catch {
    // Chrome throws when the click that started this has gone stale. The link is fine.
    return { error: "permission_denied" };
  }
  let running = false;
  try {
    running = await deps.probe(handle);
  } catch {
    running = false;
  }
  if (!running) {
    // Moved, deleted, or Chrome now runs the extension from somewhere else: the stored
    // handle describes a folder that is no longer the install, so it must not be reused.
    await deps.clearFolder().catch(() => {});
    return { error: "not_linked" };
  }

  // 3. The archive and its signature.
  let zip: Uint8Array;
  let signature: string;
  try {
    zip = await download(deps.fetch, latest.zipUrl, MAX_ZIP_BYTES);
    signature = new TextDecoder().decode(await download(deps.fetch, latest.sigUrl, MAX_SIG_BYTES));
  } catch (error) {
    return { error: error instanceof TooLarge ? "too_large" : "download_failed" };
  }

  // 4. Signed by a listed release key.
  if (!(await verifyReleaseSignature(zip, signature, deps.publicKeys))) return { error: "bad_signature" };

  // 5. Safe to unpack.
  let release: ReturnType<typeof unpackRelease>;
  try {
    release = unpackRelease(zip);
  } catch {
    return { error: "unsafe_archive" };
  }

  // 6. The signed manifest, not the tag, decides what this is: it must be the release the
  // state announced, newer than what runs, and for this same extension.
  const { manifest } = release;
  if (
    manifest.version !== latest.version ||
    !isNewerVersion(manifest.version, deps.runningVersion()) ||
    // A release with no key, or an extension with none, never counts as a match.
    typeof manifest.key !== "string" ||
    manifest.key.length === 0 ||
    manifest.key !== deps.runningKey()
  ) {
    return { error: "version_mismatch" };
  }

  // The download took a while; a job may have started in the meantime.
  const busyAgain = await busyNow(deps);
  if (busyAgain) return busyAgain;

  // 7. Write.
  const dir = deps.directory(handle);
  try {
    await applyUpdate(dir, release.files, await readInstalledFileList(dir));
  } catch (error) {
    if (!(error instanceof UpdateWriteError)) console.warn("Update failed unexpectedly", error);
    return { error: "write_failed" };
  }

  // 8. The new files are in place, whatever cleanup could not be done.
  deps.reload();
  return "reloading";
}

export type LinkResult = "linked" | "cancelled" | "wrong_folder" | "failed";

/** Lets the user pick the folder, proves it is the running one, and remembers it. */
export async function linkFolder(
  link: () => Promise<FileSystemDirectoryHandle> = () => linkExtensionFolder(),
): Promise<LinkResult> {
  try {
    await link();
    return "linked";
  } catch (error) {
    // Closing the picker is an answer, not a failure.
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    if (error instanceof NotRunningFolderError) return "wrong_folder";
    return "failed";
  }
}

/** Whether a folder is linked already. A store that cannot be read counts as not linked. */
export async function folderLinked(
  load: () => Promise<FileSystemDirectoryHandle | null> = () => loadLinkedFolder(),
): Promise<boolean> {
  try {
    return (await load()) !== null;
  } catch {
    return false;
  }
}
