import type { DirectoryPort } from "../update/applyUpdate.js";

const PROBE_FILE = ".nashir-probe";

/** The picked folder is not the one Chrome is running this extension from. */
export class NotRunningFolderError extends Error {
  constructor() {
    super("The selected folder is not the folder this extension is running from.");
    this.name = "NotRunningFolderError";
  }
}

/** DirectoryPort over a File System Access directory handle; paths are `/`-separated. */
export class FsAccessDirectory implements DirectoryPort {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async exists(path: string): Promise<boolean> {
    return (await this.fileHandle(path, false)) !== null;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const handle = await this.fileHandle(path, false);
    if (!handle) return null;
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const handle = await this.fileHandle(path, true);
    if (!handle) throw new Error(`Could not create ${path}`);
    const writable = await handle.createWritable();
    try {
      await writable.write(data as Uint8Array<ArrayBuffer>);
      // Nothing reaches the file until close, so an aborted write leaves the original intact.
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async deleteFile(path: string): Promise<void> {
    const parent = await this.directory(path, false);
    if (!parent) throw new Error(`No such file: ${path}`);
    await parent.dir.removeEntry(parent.name);
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parent = await this.directory(path, create);
    if (!parent) return null;
    try {
      return await parent.dir.getFileHandle(parent.name, { create });
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  /** The directory holding `path` plus the last segment, or null when a parent is missing. */
  private async directory(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const segments = path.split("/");
    const name = segments.pop()!;
    let dir = this.root;
    for (const segment of segments) {
      try {
        dir = await dir.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
    }
    return { dir, name };
  }
}

/** A missing entry, or a file sitting where a directory is expected (and vice versa). */
function isAbsent(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
}

/**
 * Proves a folder is the one Chrome loads the extension from: write a random nonce into
 * it, then read it back through the extension's own URL. Always removes the probe file.
 */
export async function probeFolder(
  handle: FileSystemDirectoryHandle,
  deps: { fetch?: typeof fetch } = {},
): Promise<boolean> {
  const fetchFn = deps.fetch ?? fetch;
  const dir = new FsAccessDirectory(handle);
  const nonce = crypto.randomUUID();
  try {
    await dir.writeFile(PROBE_FILE, new TextEncoder().encode(nonce));
    const url = `${chrome.runtime.getURL(PROBE_FILE)}?t=${Date.now()}`;
    const response = await fetchFn(url, { cache: "no-store" });
    return response.ok && (await response.text()) === nonce;
  } catch {
    return false;
  } finally {
    await dir.deleteFile(PROBE_FILE).catch(() => {});
  }
}

/** Where the linked folder handle is remembered between visits. */
export interface FolderKv {
  get(): Promise<FileSystemDirectoryHandle | null>;
  set(handle: FileSystemDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "nashir-update";
const STORE = "kv";
const FOLDER_KEY = "folder";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Directory handles are structured-cloneable, so IndexedDB can hold them directly. */
export const indexedDbFolderKv: FolderKv = {
  async get() {
    return ((await withStore("readonly", (s) => s.get(FOLDER_KEY))) as FileSystemDirectoryHandle | undefined) ?? null;
  },
  async set(handle) {
    await withStore("readwrite", (s) => s.put(handle, FOLDER_KEY));
  },
  async clear() {
    await withStore("readwrite", (s) => s.delete(FOLDER_KEY));
  },
};

export interface LinkDeps {
  pick?: () => Promise<FileSystemDirectoryHandle>;
  fetch?: typeof fetch;
  kv?: FolderKv;
}

/** Lets the user pick the extension folder, verifies it is the running one, and remembers it. */
export async function linkExtensionFolder(deps: LinkDeps = {}): Promise<FileSystemDirectoryHandle> {
  const pick = deps.pick ?? (() => window.showDirectoryPicker({ mode: "readwrite", id: "nashir" }));
  const kv = deps.kv ?? indexedDbFolderKv;
  const handle = await pick();
  if (!(await probeFolder(handle, { fetch: deps.fetch }))) throw new NotRunningFolderError();
  await kv.set(handle);
  return handle;
}

export function loadLinkedFolder(kv: FolderKv = indexedDbFolderKv): Promise<FileSystemDirectoryHandle | null> {
  return kv.get();
}

export function clearLinkedFolder(kv: FolderKv = indexedDbFolderKv): Promise<void> {
  return kv.clear();
}

/** Whether we may write to the folder, asking the user if they have not been asked yet. */
export async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const options = { mode: "readwrite" } as const;
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}
