import type { DirectoryPort } from "./applyUpdate.js";

/**
 * In-memory DirectoryPort for tests. Records every write and delete in order and can
 * be told to fail one specific write, so tests can assert on ordering and rollback.
 *
 * With `caseInsensitive` it behaves like a Windows folder: lookups ignore case and a
 * write over an existing name keeps the name it already had.
 */
export class MemoryDirectory implements DirectoryPort {
  /** Keyed by the lookup key (the path itself, or its lower-cased form when case-insensitive). */
  readonly files = new Map<string, Uint8Array>();
  private readonly names = new Map<string, string>();
  /** Paths in the order writeFile was called, including writes made by a rollback. */
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  /** Every write and delete in one ordered log, as `write:<path>` / `delete:<path>`. */
  readonly ops: string[] = [];
  private writeCalls = 0;
  private failAt: number | null = null;

  constructor(
    initial: Record<string, string> = {},
    private readonly options: { caseInsensitive?: boolean } = {},
  ) {
    for (const [path, text] of Object.entries(initial)) {
      this.store(path, new TextEncoder().encode(text));
    }
  }

  private key(path: string): string {
    return this.options.caseInsensitive ? path.toLowerCase() : path;
  }

  private store(path: string, data: Uint8Array): void {
    const key = this.key(path);
    if (!this.names.has(key)) this.names.set(key, path);
    this.files.set(key, data.slice());
  }

  /** Makes the n-th writeFile call (1-based, counted from now) throw, once. */
  failOnWrite(n: number): void {
    this.writeCalls = 0;
    this.failAt = n;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.key(path));
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(this.key(path));
    return data ? data.slice() : null;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writeCalls += 1;
    this.writes.push(path);
    this.ops.push(`write:${path}`);
    if (this.failAt === this.writeCalls) throw new Error(`injected write failure for ${path}`);
    this.store(path, data);
  }

  async deleteFile(path: string): Promise<void> {
    this.deletes.push(path);
    this.ops.push(`delete:${path}`);
    const key = this.key(path);
    if (!this.files.delete(key)) throw new Error(`no such file: ${path}`);
    this.names.delete(key);
  }

  /** path to text, sorted, for whole-directory equality assertions. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const entries = [...this.files.keys()].map((key) => [this.names.get(key)!, key] as const);
    for (const [name, key] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[name] = new TextDecoder().decode(this.files.get(key)!);
    }
    return out;
  }
}
