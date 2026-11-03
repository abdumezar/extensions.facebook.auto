import { unzipSync } from "fflate";
import { isSafeReleasePath } from "./applyUpdate.js";

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

export interface UnpackedRelease {
  files: Map<string, Uint8Array>;
  manifest: { version: string; key?: string };
  /** The release's own `nashir-files.json`: every path in the archive, itself included. */
  fileList: string[];
}

const MANIFEST = "manifest.json";
const FILE_LIST = "nashir-files.json";

const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new UnsafeArchiveError(`${name} is not valid JSON.`);
  }
}

/**
 * Reads a release zip into memory and refuses it whole if anything about it is off:
 * an entry path that is not a plain relative path (see `isSafeReleasePath`), two paths
 * that differ only by case or listed twice, no `manifest.json` or `nashir-files.json` at the root, a
 * manifest without a version, or a file list that does not match the entries. Nothing
 * here touches a folder; the caller writes only what comes back.
 */
export function unpackRelease(zip: Uint8Array): UnpackedRelease {
  // unzipSync returns an object keyed by name, so a repeated name would silently keep only
  // the last entry. Everything that has to see each entry (count, size, duplicates) runs in
  // the filter, before anything is inflated.
  let count = 0;
  let unpackedBytes = 0;
  const seen = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (entry) => {
        if (++count > MAX_ENTRIES) throw new UnsafeArchiveError("The release has too many files.");
        unpackedBytes += entry.originalSize;
        if (unpackedBytes > MAX_UNPACKED_BYTES) throw new UnsafeArchiveError("The release is too large.");
        if (!entry.name.endsWith("/")) {
          const key = entry.name.toLowerCase();
          if (seen.has(key)) throw new UnsafeArchiveError(`The release lists ${JSON.stringify(entry.name)} twice.`);
          seen.add(key);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw error;
    throw new UnsafeArchiveError("The release is not a readable zip archive.");
  }

  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry; folders are created as files are written
    if (!isSafeReleasePath(name)) throw new UnsafeArchiveError(`Unsafe path in the release: ${JSON.stringify(name)}.`);
    files.set(name, data);
  }
  // A path cannot be both a file and the folder of another file (compared case-insensitively).
  for (const name of files.keys()) {
    const parts = name.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/"))) {
        throw new UnsafeArchiveError(`${JSON.stringify(name)} sits inside a path that is also a file.`);
      }
    }
  }

  const manifestBytes = files.get(MANIFEST);
  if (!manifestBytes) throw new UnsafeArchiveError("The release has no manifest.json at its root.");
  const fileListBytes = files.get(FILE_LIST);
  if (!fileListBytes) throw new UnsafeArchiveError("The release has no nashir-files.json at its root.");

  const rawManifest = parseJson(manifestBytes, MANIFEST) as { version?: unknown; key?: unknown } | null;
  if (typeof rawManifest !== "object" || rawManifest === null || Array.isArray(rawManifest)) {
    throw new UnsafeArchiveError("manifest.json is not an object.");
  }
  if (typeof rawManifest.version !== "string" || rawManifest.version === "") {
    throw new UnsafeArchiveError("manifest.json has no version.");
  }
  const manifest: UnpackedRelease["manifest"] = { version: rawManifest.version };
  if (typeof rawManifest.key === "string") manifest.key = rawManifest.key;

  const fileList = parseJson(fileListBytes, FILE_LIST);
  // UTF-16 code-unit order (default sort), the same order the release packer writes.
  const expected = [...files.keys()].sort();
  if (
    !Array.isArray(fileList) ||
    fileList.length !== expected.length ||
    fileList.some((path, index) => path !== expected[index])
  ) {
    throw new UnsafeArchiveError("nashir-files.json does not match the files in the release.");
  }

  return { files, manifest, fileList: fileList as string[] };
}
