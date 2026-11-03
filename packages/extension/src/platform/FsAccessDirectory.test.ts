import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureWritePermission,
  FsAccessDirectory,
  linkExtensionFolder,
  loadLinkedFolder,
  clearLinkedFolder,
  NotRunningFolderError,
  probeFolder,
  type FolderKv,
} from "./FsAccessDirectory.js";

/** Just enough of FileSystemDirectoryHandle for FsAccessDirectory, backed by maps. */
class FakeDir {
  readonly kind = "directory";
  readonly children = new Map<string, FakeDir | Uint8Array>();
  aborted = 0;
  failWrites = false;
  constructor(readonly name = "root") {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const child = this.children.get(name);
    if (child instanceof FakeDir) return child;
    if (child) throw new DOMException("not a directory", "TypeMismatchError");
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new FakeDir(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const child = this.children.get(name);
    if (child instanceof FakeDir) throw new DOMException("not a file", "TypeMismatchError");
    if (!child && !options?.create) throw new DOMException("missing", "NotFoundError");
    if (!child) this.children.set(name, new Uint8Array());
    return {
      kind: "file",
      getFile: async () => new File([this.children.get(name) as Uint8Array<ArrayBuffer>], name),
      // Like the real thing: bytes are staged by write() and only land in the file on close().
      createWritable: async () => {
        let staged: Uint8Array | null = null;
        return {
          write: async (data: Uint8Array) => {
            if (this.failWrites) throw new DOMException("disk full", "QuotaExceededError");
            staged = data.slice();
          },
          close: async () => {
            if (staged) this.children.set(name, staged);
          },
          abort: async () => {
            this.aborted += 1;
            staged = null;
          },
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }

  text(path: string): string | null {
    let node: FakeDir | Uint8Array | undefined = this;
    for (const segment of path.split("/")) {
      node = node instanceof FakeDir ? node.children.get(segment) : undefined;
    }
    return node instanceof Uint8Array ? new TextDecoder().decode(node) : null;
  }
}

const asHandle = (dir: FakeDir) => dir as unknown as FileSystemDirectoryHandle;
const bytes = (text: string) => new TextEncoder().encode(text);

afterEach(() => vi.unstubAllGlobals());

describe("FsAccessDirectory", () => {
  it("creates nested directories on write and reads the file back", async () => {
    const root = new FakeDir();
    const dir = new FsAccessDirectory(asHandle(root));
    await dir.writeFile("assets/deep/app.js", bytes("hello"));
    expect(root.text("assets/deep/app.js")).toBe("hello");
    expect(new TextDecoder().decode((await dir.readFile("assets/deep/app.js"))!)).toBe("hello");
  });

  it("overwrites an existing file completely", async () => {
    const root = new FakeDir();
    const dir = new FsAccessDirectory(asHandle(root));
    await dir.writeFile("a.js", bytes("long original"));
    await dir.writeFile("a.js", bytes("short"));
    expect(root.text("a.js")).toBe("short");
  });

  it("reports missing files and directories as absent", async () => {
    const dir = new FsAccessDirectory(asHandle(new FakeDir()));
    expect(await dir.exists("nope.js")).toBe(false);
    expect(await dir.exists("no/such/dir.js")).toBe(false);
    expect(await dir.readFile("no/such/dir.js")).toBeNull();
  });

  it("treats a file where a directory is expected as absent", async () => {
    const root = new FakeDir();
    const dir = new FsAccessDirectory(asHandle(root));
    await dir.writeFile("a", bytes("file"));
    expect(await dir.exists("a/b.js")).toBe(false);
    expect(await dir.exists("a")).toBe(true);
  });

  it("aborts the stream and rethrows when a write fails", async () => {
    const root = new FakeDir();
    const dir = new FsAccessDirectory(asHandle(root));
    await dir.writeFile("a.js", bytes("original"));
    root.failWrites = true;
    await expect(dir.writeFile("a.js", bytes("replacement"))).rejects.toThrow("disk full");
    expect(root.aborted).toBe(1);
    expect(root.text("a.js")).toBe("original");
  });

  it("deletes a nested file", async () => {
    const root = new FakeDir();
    const dir = new FsAccessDirectory(asHandle(root));
    await dir.writeFile("x/y.js", bytes("1"));
    await dir.deleteFile("x/y.js");
    expect(await dir.exists("x/y.js")).toBe(false);
  });

  it("surfaces deleting a file that is not there", async () => {
    const dir = new FsAccessDirectory(asHandle(new FakeDir()));
    await expect(dir.deleteFile("missing.js")).rejects.toBeDefined();
  });
});

function stubChrome() {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` } });
}

/** A fetch that serves whatever probe file is currently in the folder, like Chrome would. */
function fetchServing(root: FakeDir) {
  return vi.fn(async () => ({ ok: true, text: async () => root.text(".nashir-probe") ?? "" }) as Response);
}

describe("probeFolder", () => {
  it("is true when the running extension serves the nonce, and removes the probe", async () => {
    stubChrome();
    const root = new FakeDir();
    const fetchFn = fetchServing(root);

    expect(await probeFolder(asHandle(root), { fetch: fetchFn })).toBe(true);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^chrome-extension:\/\/abc\/\.nashir-probe\?t=\d+$/);
    expect(init.cache).toBe("no-store");
    expect(root.children.has(".nashir-probe")).toBe(false);
  });

  it("is false when the served content differs, and still removes the probe", async () => {
    stubChrome();
    const root = new FakeDir();
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => "someone else" }) as Response);
    expect(await probeFolder(asHandle(root), { fetch: fetchFn })).toBe(false);
    expect(root.children.has(".nashir-probe")).toBe(false);
  });

  it("is false when the fetch fails", async () => {
    stubChrome();
    const root = new FakeDir();
    const fetchFn = vi.fn(async () => {
      throw new TypeError("net::ERR_FILE_NOT_FOUND");
    });
    expect(await probeFolder(asHandle(root), { fetch: fetchFn })).toBe(false);
    expect(root.children.has(".nashir-probe")).toBe(false);
  });
});

function memoryKv(): FolderKv & { stored: FileSystemDirectoryHandle | null } {
  const kv = {
    stored: null as FileSystemDirectoryHandle | null,
    async get() {
      return kv.stored;
    },
    async set(handle: FileSystemDirectoryHandle) {
      kv.stored = handle;
    },
    async clear() {
      kv.stored = null;
    },
  };
  return kv;
}

describe("linkExtensionFolder", () => {
  it("refuses a folder that is not the running extension", async () => {
    stubChrome();
    const root = new FakeDir();
    const kv = memoryKv();
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => "another nonce" }) as Response);

    await expect(
      linkExtensionFolder({ pick: async () => asHandle(root), fetch: fetchFn, kv }),
    ).rejects.toBeInstanceOf(NotRunningFolderError);
    expect(kv.stored).toBeNull();
  });

  it("persists the handle when the probe matches", async () => {
    stubChrome();
    const root = new FakeDir();
    const kv = memoryKv();

    const handle = await linkExtensionFolder({ pick: async () => asHandle(root), fetch: fetchServing(root), kv });

    expect(handle).toBe(asHandle(root));
    expect(kv.stored).toBe(asHandle(root));
  });
});

describe("linked folder storage", () => {
  it("loads and clears the stored handle", async () => {
    const kv = memoryKv();
    expect(await loadLinkedFolder(kv)).toBeNull();
    await kv.set(asHandle(new FakeDir()));
    expect(await loadLinkedFolder(kv)).not.toBeNull();
    await clearLinkedFolder(kv);
    expect(await loadLinkedFolder(kv)).toBeNull();
  });
});

describe("ensureWritePermission", () => {
  const withPermission = (query: PermissionState, request: PermissionState) => {
    const requestPermission = vi.fn(async () => request);
    const handle = { queryPermission: vi.fn(async () => query), requestPermission } as unknown as FileSystemDirectoryHandle;
    return { handle, requestPermission };
  };

  it("does not prompt when already granted", async () => {
    const { handle, requestPermission } = withPermission("granted", "denied");
    expect(await ensureWritePermission(handle)).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("prompts when not yet granted", async () => {
    const { handle, requestPermission } = withPermission("prompt", "granted");
    expect(await ensureWritePermission(handle)).toBe(true);
    expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("is false when the user declines", async () => {
    const { handle } = withPermission("prompt", "denied");
    expect(await ensureWritePermission(handle)).toBe(false);
  });
});
