/** Relative, `/`-separated file access to the folder the extension runs from. */
export interface DirectoryPort {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export class UpdateWriteError extends Error {
  constructor(
    message: string,
    /** True when every touched file was put back the way it was. */
    readonly restored: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateWriteError";
  }
}

const MANIFEST = "manifest.json";
const FILE_LIST = "nashir-files.json";
/** Names Windows reserves as devices, with or without an extension. */
const RESERVED_BASE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a release-relative path is safe to join onto the extension folder: no
 * absolute or drive paths, no `..`, no backslashes, no empty or `.` segments, no
 * segment Windows would silently rewrite (trailing dot or space) or reserve as a
 * device name, and only plain filename characters.
 */
export function isSafeReleasePath(path: string): boolean {
  if (path === "") return false;
  return path.split("/").every((segment) => {
    if (segment === "." || segment === ".." || segment.endsWith(".")) return false;
    if (!SAFE_SEGMENT.test(segment)) return false;
    return !RESERVED_BASE_NAME.test(segment.split(".")[0]!);
  });
}

type Log = (message: string, meta?: Record<string, unknown>) => void;

/**
 * Writes a verified release into the folder so an interruption never leaves a manifest
 * pointing at missing files: new paths first, then overwrites, then `nashir-files.json`,
 * then `manifest.json` last. Only after all of that succeeds are files the previous
 * release owned (and the new one dropped) removed. A failure before then restores every
 * original and deletes every file this run created; directories created along the way
 * are left behind, empty.
 *
 * Paths are compared case-insensitively where it matters because the folder usually
 * lives on Windows, where `Foo.js` and `foo.js` are one file.
 */
export async function applyUpdate(
  dir: DirectoryPort,
  files: Map<string, Uint8Array>,
  previousFileList: string[] | null,
  log: Log = (message, meta) => console.warn(message, meta),
): Promise<{ written: number; removed: number }> {
  const paths = [...files.keys()];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!isSafeReleasePath(path)) throw new UpdateWriteError("The release contains an unsafe path.", true);
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new UpdateWriteError("The release contains paths that differ only by case.", true);
    seen.add(folded);
  }
  const manifestPath = paths.find((path) => path.toLowerCase() === MANIFEST);
  if (!manifestPath) throw new UpdateWriteError("The release has no manifest.json.", true);
  const fileListPath = paths.find((path) => path.toLowerCase() === FILE_LIST);
  // Written last and in this order: the file list, then the manifest that makes Chrome use it.
  const tail = fileListPath ? [fileListPath, manifestPath] : [manifestPath];

  const originals = new Map<string, Uint8Array>();
  const created: string[] = [];
  let written = 0;

  const write = async (path: string) => {
    await dir.writeFile(path, files.get(path)!);
    written += 1;
  };
  const overwriteWithSnapshot = async (path: string) => {
    const original = await dir.readFile(path);
    // Without the original there is nothing to roll back to, so do not touch it.
    if (!original) throw new Error(`Could not read ${path} before replacing it.`);
    originals.set(path, original);
    await write(path);
  };

  try {
    const fresh: string[] = [];
    const overwrite: string[] = [];
    for (const path of paths) {
      if (tail.includes(path)) continue;
      if (await dir.exists(path)) overwrite.push(path);
      else fresh.push(path);
    }

    for (const path of fresh) {
      created.push(path);
      await write(path);
    }
    for (const path of overwrite) await overwriteWithSnapshot(path);
    for (const path of tail) {
      if (await dir.exists(path)) await overwriteWithSnapshot(path);
      else {
        created.push(path);
        await write(path);
      }
    }
  } catch (cause) {
    const restored = await rollback(dir, originals, created);
    throw new UpdateWriteError(
      restored
        ? "Update could not be written; the previous version was restored."
        : "Update could not be written and the previous version could not be fully restored.",
      restored,
      { cause },
    );
  }

  return { written, removed: await removeStale(dir, files, previousFileList, log) };
}

async function rollback(dir: DirectoryPort, originals: Map<string, Uint8Array>, created: string[]): Promise<boolean> {
  let ok = true;
  for (const [path, data] of originals) {
    try {
      await dir.writeFile(path, data);
    } catch {
      ok = false;
    }
  }
  for (const path of created) {
    try {
      if (await dir.exists(path)) await dir.deleteFile(path);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * Deletes `previous - new`, case-insensitively. By the time this runs the update is
 * already in place, so nothing here may throw: failures are logged and the caller still
 * reloads the extension.
 */
async function removeStale(
  dir: DirectoryPort,
  files: Map<string, Uint8Array>,
  previousFileList: string[] | null,
  log: Log,
): Promise<number> {
  let removed = 0;
  try {
    if (!Array.isArray(previousFileList)) return 0;
    const keep = new Set([...files.keys()].map((path) => path.toLowerCase()));
    // The list was read from disk, so it is untrusted: keep only safe string paths, and
    // never the manifest.
    const stale = new Set(
      (previousFileList as unknown[]).filter(
        (path): path is string =>
          typeof path === "string" &&
          isSafeReleasePath(path) &&
          !keep.has(path.toLowerCase()) &&
          path.toLowerCase() !== MANIFEST,
      ),
    );
    for (const path of stale) {
      try {
        if (!(await dir.exists(path))) continue;
        await dir.deleteFile(path);
        removed += 1;
      } catch (error) {
        log(`Could not remove stale file ${path}`, { error: String(error) });
      }
    }
  } catch (error) {
    log("Could not clean up files from the previous release", { error: String(error) });
  }
  return removed;
}
