import { openDB, type IDBPDatabase } from "idb";

/**
 * MediaStore — holds picked image/video blobs in IndexedDB. The extension pages and
 * the service worker share the same extension origin, so a blob stashed by the
 * dashboard picker is readable by the engine when it uploads during a run.
 */
export interface MediaRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  kind: "image" | "video";
  addedAt: number;
}

export class MediaStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB("nashir-media", 1, {
        upgrade(db) {
          db.createObjectStore("media", { keyPath: "id" });
        },
      });
    }
    return this.dbPromise;
  }

  /**
   * The counter matters: picking several files at once writes them within the same
   * millisecond, and two identically-named files would otherwise collide onto one id —
   * silently making both attachments the same blob, and one removal delete both.
   */
  private seq = 0;

  async put(rec: Omit<MediaRecord, "id" | "addedAt">): Promise<string> {
    const slug = rec.name.replace(/\W+/g, "").slice(0, 12);
    const id = `m_${Date.now()}_${this.seq++}_${slug}`;
    const db = await this.db();
    await db.put("media", { ...rec, id, addedAt: Date.now() } satisfies MediaRecord);
    return id;
  }

  async get(id: string): Promise<MediaRecord | null> {
    const db = await this.db();
    return ((await db.get("media", id)) as MediaRecord | undefined) ?? null;
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    await db.delete("media", id);
  }
}
