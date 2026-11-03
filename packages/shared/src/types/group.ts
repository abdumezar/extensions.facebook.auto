/** A Facebook group the user has joined. */
export interface Group {
  id: string;
  name: string;
  /** Whether posts require admin approval (best-effort, from group metadata). */
  requiresApproval?: boolean;
  /** Member count, when available. */
  memberCount?: number;
  /** Group URL. */
  url?: string;
}

/**
 * A cached group list plus the moment it was fetched. Groups are loaded once a live
 * session yields tokens and then served from here, so opening the dashboard never
 * waits on Facebook; `syncedAt` is what tells the UI (and the auto-sync) how stale it is.
 */
export interface GroupCache {
  accountId: string;
  groups: Group[];
  syncedAt: number;
  /**
   * Present while the joined-groups walk stopped before Facebook's last page, so the
   * next batch can resume from `cursor` instead of starting over. Absent means the list
   * is complete — including caches written before walks existed.
   */
  walk?: GroupWalk;
}

/** Where an unfinished joined-groups walk stopped. */
export interface GroupWalk {
  cursor: string;
  /** When the walk began. A cursor older than the resume window is not trusted. */
  startedAt: number;
  /** Ids confirmed by this walk so far; only these survive once it completes. */
  seenIds: string[];
  /** Requests spent on this walk across all batches, root query included. */
  requests: number;
}

/** A named, saved set of group ids (e.g. "Marketing Groups"). Per account. */
export interface GroupList {
  id: string;
  accountId: string;
  name: string;
  groupIds: string[];
  createdAt: number;
}

/**
 * What Facebook says about leaving a group — the contents of its own confirmation
 * dialog, fetched before we act.
 *
 * There is no "delete group" API: a group is deleted by its last member leaving, so the
 * same call is either "I'm out" or "this group is gone for everyone". Nothing here says
 * which for certain — `canDelete` is Facebook offering an outright delete, and
 * `deletesGroupWhenLastMemberLeaves` is a property of the GROUP (it is true even for a
 * group with tens of thousands of members), not a claim that the viewer is the last one.
 * These fields warn; the mutation's own response is what confirms what happened.
 */
export interface GroupLeavePreview {
  groupId: string;
  name?: string;
  url?: string;
  /** Facebook's own headline for the confirmation, e.g. "Are you sure?". */
  confirmationTitle?: string;
  /** Facebook's own label for the confirm button, e.g. "Leave group". */
  leaveLabel?: string;
  /** Facebook's scenario enum, e.g. "MEMBER_NOTIFICATIONS". Logged, not branched on. */
  leaveScenario?: string;
  /** "CLOSED" / "OPEN" / "SECRET". */
  visibility?: string;
  /** True ⇒ this group is destroyed once its LAST member leaves (may not be the viewer). */
  deletesGroupWhenLastMemberLeaves: boolean;
  /** True ⇒ Facebook offers this viewer an outright delete. */
  canDelete: boolean;
}

/**
 * How one leave attempt ended.
 *  - `left`    — the viewer is no longer a member; the group still exists.
 *  - `deleted` — the viewer was the last member, so the group is gone.
 *  - `failed`  — Facebook rejected it (the `error` says why).
 *  - `skipped` — never attempted, because an earlier group in the batch failed hard.
 */
export type GroupLeaveOutcome = "left" | "deleted" | "failed" | "skipped";

export interface GroupLeaveResult {
  groupId: string;
  /** Name at the time of the attempt, from the cache — the group may no longer exist. */
  name?: string;
  outcome: GroupLeaveOutcome;
  error?: string;
}
