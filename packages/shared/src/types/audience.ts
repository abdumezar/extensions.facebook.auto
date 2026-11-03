/**
 * Audience types — the people who reacted to and commented on a post.
 *
 * The only personal data this product holds. It lives on the operator's device, in
 * IndexedDB, and is never sent anywhere: no server holds a copy of the profiles the
 * operator extracts.
 */

import type { Contact } from "./contact.js";

/** Where a sighting came from. `post.*` is one post; the loop kinds are our own posts. */
export type AudienceSource = "post.reactor" | "post.commenter" | "own.commenter";

/** One sighting of one person on one post. A person seen twice has two of these. */
export interface AudienceSighting {
  source: AudienceSource;
  /** The post permalink the operator gave us, verbatim, so a row is traceable. */
  postUrl: string;
  /** Facebook's feedback id for that post — the key every audience query takes. */
  feedbackId: string;
  /** Group the post lives in, when the URL carried one. */
  groupId?: string;
  /** Stable English reaction name, or the raw id when the recipe has no name for it. */
  reaction?: string;
  /** Comment fields. Absent on a reactor sighting. */
  commentId?: string;
  parentId?: string;
  depth?: number;
  text?: string;
  /** Unix seconds, as Facebook reports it. */
  createdAt?: number;
  /** When we captured it. Unix ms. */
  capturedAt: number;
}

/**
 * One person, merged across every sighting.
 *
 * Keyed by Facebook user id alone — deliberately not by (post, user). The whole value
 * of the store is that someone who commented on three of your posts surfaces as one
 * warm lead with three sightings, rather than as three rows you mail three times.
 */
export interface AudienceContact {
  /** Facebook user id. The primary key. */
  id: string;
  name: string;
  profileUrl?: string;
  profilePicUrl?: string;
  isVerified?: boolean;
  /** Every contact detail parsed out of anything this person wrote. */
  contacts: Contact[];
  sightings: AudienceSighting[];
  /** Max confidence across `contacts`. Denormalised so the table can sort on it. */
  bestConfidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Why a person must not be contacted again. */
export type SuppressionReason = "contacted" | "do_not_contact" | "bounced";

export interface SuppressionEntry {
  /** Facebook user id, or an E.164 number — both are addressable. */
  id: string;
  reason: SuppressionReason;
  at: number;
  note?: string;
}

/** What the extractor is doing right now. Polled by the page, like `RunSnapshot`. */
export type ExtractionStatus =
  | "idle"
  | "resolving"
  | "reactors"
  | "comments"
  | "done"
  | "aborted"
  | "error"
  | "cooldown"
  /** The recipe has no doc_id for this. Same contract as `LinkPreview`'s unsupported. */
  | "unsupported";

export interface ExtractionState {
  status: ExtractionStatus;
  postUrl: string;
  feedbackId?: string;
  groupId?: string;
  /** People written to the store so far. */
  found: number;
  /** Contact details found so far — the number the operator actually watches. */
  withContact: number;
  reactorPages: number;
  commentPages: number;
  /** Facebook's own total, when it gave us one. */
  totalComments?: number;
  startedAt: number;
  finishedAt?: number;
  /** Set on `error` / `cooldown` / `unsupported`. Facebook's words where we have them. */
  message?: string;
  /**
   * True when a page cap or the governor stopped us before the list ran out. The UI
   * must say so: a partial extraction that looks complete is worse than a failed one,
   * because the operator acts on it.
   */
  truncated: boolean;
}

/** Filters the dashboard sends with a query. */
export interface AudienceQuery {
  /** Substring match on name or contact value. */
  search?: string;
  source?: AudienceSource;
  postUrl?: string;
  /** Only people we found a phone or email for. */
  withContactOnly?: boolean;
  minConfidence?: number;
  /** Drop anyone on the suppression list. Always true for an export. */
  excludeSuppressed?: boolean;
  limit?: number;
  offset?: number;
}

export interface AudiencePage {
  rows: AudienceContact[];
  total: number;
}
