import type { StoragePort } from "./ports/index.js";

/**
 * Remembers that a session was confirmed against a live Facebook page, so the
 * dashboard can say "verified 4 min ago" after the tab that proved it is closed.
 *
 * One storage key holds a map keyed by Facebook user id. The `xs` cookie is stored
 * only as a SHA-256 digest: it is enough to notice a re-login or a new session, and
 * a copy of the storage area never contains a usable cookie.
 */
export const VERIFIED_KEY = "nashir:verified";

/** Past this a past check says nothing worth showing. */
export const VERIFIED_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** A fresh entry is not rewritten inside this window — scrapes can be frequent. */
export const VERIFIED_REWRITE_MS = 5 * 60 * 1000;

/** Enough for the current session plus a few managed accounts. */
export const VERIFIED_KEEP = 5;

export interface VerifiedEntry {
  /** Epoch millis of the last successful live check. */
  at: number;
  /** SHA-256 hex of the `xs` cookie value the check ran under. */
  xs: string;
}

export type VerifiedMap = Record<string, VerifiedEntry>;

/** Injectable so tests can see what goes in without computing digests. */
export type HashFn = (value: string) => Promise<string>;

export const sha256Hex: HashFn = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

function isMap(v: unknown): v is VerifiedMap {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEntry(v: unknown): v is VerifiedEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as VerifiedEntry).at === "number" &&
    typeof (v as VerifiedEntry).xs === "string"
  );
}

async function load(storage: StoragePort): Promise<VerifiedMap> {
  const raw = await storage.get<unknown>(VERIFIED_KEY);
  return isMap(raw) ? raw : {};
}

/** Marks are read-modify-write on one key; overlapping ones must not drop each other. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Record a successful live check for `fbUserId` under the given `xs` cookie value.
 * Skipped when the stored entry is under five minutes old and `xs` is unchanged.
 */
export function markVerified(
  storage: StoragePort,
  hash: HashFn,
  fbUserId: string,
  xs: string,
  now: number,
): Promise<void> {
  const run = async () => {
    const xsHash = await hash(xs);
    const map = await load(storage);
    const current = map[fbUserId];
    if (
      isEntry(current) &&
      current.xs === xsHash &&
      now - current.at >= 0 &&
      now - current.at < VERIFIED_REWRITE_MS
    ) {
      return;
    }
    map[fbUserId] = { at: now, xs: xsHash };
    const kept = Object.entries(map)
      .filter(([, e]) => isEntry(e))
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, VERIFIED_KEEP);
    await storage.set(VERIFIED_KEY, Object.fromEntries(kept));
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * When `fbUserId` was last verified, if that check is under twelve hours old and was
 * made under the `xs` cookie the browser holds now.
 */
export async function readVerifiedAt(
  storage: StoragePort,
  hash: HashFn,
  fbUserId: string,
  xs: string,
  now: number,
): Promise<number | undefined> {
  const entry = (await load(storage))[fbUserId];
  if (!isEntry(entry)) return undefined;
  const age = now - entry.at;
  if (age < 0 || age >= VERIFIED_MAX_AGE_MS) return undefined;
  if (entry.xs !== (await hash(xs))) return undefined;
  return entry.at;
}
