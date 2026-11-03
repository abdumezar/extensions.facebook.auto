import type {
  AudienceContact,
  AudiencePage,
  AudienceQuery,
  AudienceSighting,
  Contact,
  SuppressionEntry,
} from "@nashir/shared";
import { type IDBPDatabase, openDB } from "idb";

/**
 * AudienceStore — the extracted people, on this device only.
 *
 * IndexedDB rather than chrome.storage for the same reason `AnalyticsStore` uses it:
 * one post can carry thousands of reactors and the quota would be gone in an afternoon.
 * `unlimitedStorage` is already granted.
 *
 * Two properties this class exists to guarantee:
 *
 * 1. **A person is one row.** Keyed by Facebook user id, never by (post, user). The
 *    compounding value of the dataset is that someone who commented on three of your
 *    posts is one warm lead with three sightings, not three rows you message thrice.
 * 2. **Nothing leaves.** There is no export path here that sends data off the device,
 *    and there must never be one. The only way out is a file the operator saves
 *    themselves.
 */
export class AudienceStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB("nashir-audience", 1, {
        upgrade(db) {
          const contacts = db.createObjectStore("contacts", { keyPath: "id" });
          contacts.createIndex("by_last_seen", "lastSeenAt");
          contacts.createIndex("by_confidence", "bestConfidence");
          db.createObjectStore("suppression", { keyPath: "id" });
        },
      });
    }
    return this.dbPromise;
  }

  /**
   * Merge one sighting into the store, creating the person if new.
   *
   * Returns whether this was the first time we saw them, which is the only number the
   * progress UI can honestly call "found" — counting rows written would count the same
   * person once per page they appear on.
   */
  async upsert(
    person: { id: string; name: string; profileUrl?: string; profilePicUrl?: string; isVerified?: boolean },
    sighting: AudienceSighting,
    contacts: Contact[],
    now: number,
  ): Promise<{ isNew: boolean; gainedContact: boolean }> {
    const db = await this.db();
    const tx = db.transaction("contacts", "readwrite");
    const store = tx.objectStore("contacts");
    const existing = (await store.get(person.id)) as AudienceContact | undefined;

    const merged = mergeContacts(existing?.contacts ?? [], contacts);
    const hadContact = (existing?.contacts.length ?? 0) > 0;
    const sightings = dedupeSightings([...(existing?.sightings ?? []), sighting]);

    const row: AudienceContact = {
      id: person.id,
      // A later sighting carries a fresher display name; an empty one never wins.
      name: person.name || existing?.name || "",
      contacts: merged,
      sightings,
      bestConfidence: merged.reduce((m, c) => Math.max(m, c.confidence), 0),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      ...(person.profileUrl || existing?.profileUrl
        ? { profileUrl: person.profileUrl ?? existing?.profileUrl }
        : {}),
      ...(person.profilePicUrl || existing?.profilePicUrl
        ? { profilePicUrl: person.profilePicUrl ?? existing?.profilePicUrl }
        : {}),
      ...(person.isVerified ?? existing?.isVerified) !== undefined
        ? { isVerified: person.isVerified ?? existing?.isVerified }
        : {},
    };

    await store.put(row);
    await tx.done;
    return { isNew: !existing, gainedContact: !hadContact && merged.length > 0 };
  }

  async get(id: string): Promise<AudienceContact | undefined> {
    const db = await this.db();
    return (await db.get("contacts", id)) as AudienceContact | undefined;
  }

  /** Everything, newest sighting first. */
  async all(): Promise<AudienceContact[]> {
    const db = await this.db();
    const rows = (await db.getAll("contacts")) as AudienceContact[];
    return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Filtered, sorted and paged.
   *
   * Filtering in memory is deliberate. The alternative is a compound index per filter
   * combination, and the whole set is a few tens of thousands of rows in the worst
   * case — small enough that the simple version is also the fast one.
   */
  async query(q: AudienceQuery = {}): Promise<AudiencePage> {
    const rows = await this.all();
    const suppressed = q.excludeSuppressed ? await this.suppressedKeys() : null;
    const needle = q.search?.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      if (suppressed && isSuppressed(r, suppressed)) return false;
      if (q.source && !r.sightings.some((s) => s.source === q.source)) return false;
      if (q.postUrl && !r.sightings.some((s) => s.postUrl === q.postUrl)) return false;
      if (q.withContactOnly && r.contacts.length === 0) return false;
      if (q.minConfidence !== undefined && r.bestConfidence < q.minConfidence) return false;
      if (needle) {
        const hay = `${r.name} ${r.contacts.map((c) => c.value).join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const offset = q.offset ?? 0;
    const limit = q.limit ?? filtered.length;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  // -------------------------------------------------------------- suppression

  /**
   * Mark someone as contacted, or as never-to-be-contacted.
   *
   * Both the user id and the phone number are addressable keys, because the two ways a
   * duplicate reaches a person are messaging the same profile twice and messaging
   * the same number found under two profiles.
   */
  async suppress(entry: SuppressionEntry): Promise<void> {
    const db = await this.db();
    await db.put("suppression", entry);
  }

  async unsuppress(id: string): Promise<void> {
    const db = await this.db();
    await db.delete("suppression", id);
  }

  async suppressions(): Promise<SuppressionEntry[]> {
    const db = await this.db();
    return (await db.getAll("suppression")) as SuppressionEntry[];
  }

  private async suppressedKeys(): Promise<Set<string>> {
    return new Set((await this.suppressions()).map((s) => s.id));
  }

  /** How many rows we hold, without materialising them. */
  async count(): Promise<number> {
    const db = await this.db();
    return db.count("contacts");
  }

  /**
   * Wipe every extracted person. Not the suppression list: a do-not-contact record
   * must outlive the data it was about, or clearing the table silently re-permits
   * everyone the operator had already excluded.
   */
  async clear(): Promise<void> {
    const db = await this.db();
    await db.clear("contacts");
  }

  /** Wipe the suppression list too. Separate, and separately confirmed. */
  async clearSuppression(): Promise<void> {
    const db = await this.db();
    await db.clear("suppression");
  }
}

// ---------------------------------------------------------------- pure helpers

/** True when either the person or any of their numbers is on the list. */
export function isSuppressed(row: AudienceContact, suppressed: Set<string>): boolean {
  if (suppressed.has(row.id)) return true;
  return row.contacts.some((c) => suppressed.has(c.value));
}

/** Union by value, keeping the highest-confidence sighting of each. */
export function mergeContacts(existing: Contact[], incoming: Contact[]): Contact[] {
  const best = new Map<string, Contact>();
  for (const c of [...existing, ...incoming]) {
    const prev = best.get(c.value);
    if (!prev || c.confidence > prev.confidence) best.set(c.value, c);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * One sighting per (source, post, comment).
 *
 * Re-extracting a post must not grow the row every time. A reactor has no comment id,
 * so for them the pair (source, post) is the identity — which is correct: a person can
 * only hold one reaction on one post.
 */
export function dedupeSightings(sightings: AudienceSighting[]): AudienceSighting[] {
  const seen = new Map<string, AudienceSighting>();
  for (const s of sightings) {
    const key = `${s.source}|${s.feedbackId}|${s.commentId ?? ""}`;
    // Later wins: a re-extraction has fresher text and a fresher reaction.
    seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
