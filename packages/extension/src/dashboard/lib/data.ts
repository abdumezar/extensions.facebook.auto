import {
  CURRENT_SESSION,
  type Account,
  type Group,
  type GroupCache,
  type GroupLeavePreview,
  type GroupLeaveResult,
  type SessionStatus,
} from "@nashir/shared";
import { rpc } from "./rpc.js";
import { useStore } from "../store.js";

/**
 * The dashboard's data layer: every RPC that feeds shared store state lives here, so
 * a page never has to know whether the data it wants is already loaded, in flight, or
 * about to be replaced by a background sync.
 *
 * All of these swallow transport errors and return a flag — the service worker may be
 * cold-starting when a page mounts, and a first-paint failure is not worth a snackbar.
 */

/** Managed accounts. */
export async function loadAccounts(): Promise<Account[]> {
  const res = await rpc<Account[]>({ type: "LIST_ACCOUNTS" });
  if (res.ok && res.data) useStore.getState().setAccounts(res.data);
  return res.data ?? [];
}

/** Who is logged into Facebook in this browser right now. */
export async function loadSession(): Promise<SessionStatus | null> {
  const res = await rpc<SessionStatus>({ type: "GET_SESSION_STATUS" });
  const session = res.ok && res.data ? res.data : null;
  useStore.getState().setSession(session);
  return session;
}

/**
 * Everything needed to make the dashboard usable, on open.
 *
 * `loadSession` only ever reports what is free to know, which on a cold start with no
 * Facebook tab open is "logged in, name unknown, no groups" — a dashboard that asks
 * the user to go and add the account they are already signed into. This asks the
 * service worker to actually go and find out, opening a background tab if that is what it
 * takes, and closing it again.
 *
 * Returns whether anything was actually established, so the caller can say so.
 */
export async function bootstrapSession(): Promise<boolean> {
  const res = await rpc<{ session: SessionStatus; groups: Group[] }>({ type: "BOOTSTRAP_SESSION" });
  if (!res.ok || !res.data) return false;
  const store = useStore.getState();
  store.setSession(res.data.session);
  // Only write groups into the view if it is still the live session being shown; the
  // user may have switched to a managed account while this was in flight.
  if (store.activeAccountId === CURRENT_SESSION && res.data.groups.length > 0) {
    store.setGroups(res.data.groups, Date.now());
  }
  return Boolean(res.data.session.loggedIn);
}

/** Cached groups for an account, with no network access at all. */
export async function loadCachedGroups(accountId: string): Promise<GroupCache | null> {
  const res = await rpc<GroupCache>({ type: "GET_CACHED_GROUPS", accountId });
  if (!res.ok || !res.data) return null;
  applyGroups(accountId, res.data.groups, res.data.syncedAt, !!res.data.walk);
  return res.data;
}

/**
 * Show whatever is cached immediately, then let the service worker refresh it in the background
 * if it has aged out and a logged-in Facebook tab is open. This is what makes opening
 * the dashboard feel instant while still converging on fresh data.
 */
export async function primeGroups(accountId: string = CURRENT_SESSION): Promise<void> {
  await loadCachedGroups(accountId);
  const res = await rpc<GroupCache>({ type: "SYNC_GROUPS_IF_STALE", accountId });
  if (res.ok && res.data) applyGroups(accountId, res.data.groups, res.data.syncedAt, !!res.data.walk);
}

/** Explicit user-initiated fetch. Throws with a readable message so callers can surface it. */
export async function reloadGroups(accountId: string): Promise<Group[]> {
  const res = await rpc<Group[]>({ type: "LOAD_GROUPS", accountId, refresh: true });
  if (!res.ok || !res.data) throw new Error(res.error ?? "Failed to load groups");
  applyGroups(accountId, res.data, Date.now());
  // The load returns the list only; whether Facebook has more lives with the cache.
  await loadCachedGroups(accountId);
  return res.data;
}

/**
 * Ask Facebook what it would warn about before leaving a group. Throws so the caller
 * can keep the confirmation dialog closed rather than confirming something unknown.
 */
export async function previewLeaveGroup(accountId: string, groupId: string): Promise<GroupLeavePreview> {
  const res = await rpc<GroupLeavePreview>({ type: "PREVIEW_LEAVE_GROUP", accountId, groupId });
  if (!res.ok || !res.data) throw new Error(res.error ?? "Could not read Facebook's leave dialog");
  return res.data;
}

/**
 * Leave groups. Irreversible, and for a group the account is the last member of it is
 * a deletion — the caller must have confirmed with the user first.
 *
 * Whatever actually went (left or deleted) is pruned from the shown list and from the
 * campaign selection immediately: continuing to offer a group the account is no longer
 * in would queue posts that can only fail.
 */
export async function leaveGroups(accountId: string, groupIds: string[]): Promise<GroupLeaveResult[]> {
  const res = await rpc<GroupLeaveResult[]>({ type: "LEAVE_GROUPS", accountId, groupIds });
  if (!res.ok || !res.data) throw new Error(res.error ?? "Failed to leave the selected groups");

  const gone = new Set(res.data.filter((r) => r.outcome === "left" || r.outcome === "deleted").map((r) => r.groupId));
  if (gone.size > 0) {
    const store = useStore.getState();
    // Only touch the view if it is still showing the account we acted on.
    if (store.activeAccountId === accountId) {
      store.setGroups(store.groups.filter((g) => !gone.has(g.id)));
      store.setSelectedGroups([...store.selectedGroupIds].filter((id) => !gone.has(id)));
    }
  }
  return res.data;
}

/**
 * Write groups into the store only if they still belong to the account the user is
 * looking at — a slow response for a previously-selected account must not overwrite
 * the current one.
 */
function applyGroups(accountId: string, groups: Group[], syncedAt: number, incomplete?: boolean): void {
  const store = useStore.getState();
  if (store.activeAccountId !== accountId) return;
  // Never blank a populated list with an empty one. `GroupService` has this rule at the
  // engine level for the same reason; it is needed here too because two loaders race on
  // mount — the cheap cached read and the bootstrap that actually fetches — and the
  // cheap one resolving second would otherwise wipe what the bootstrap just found.
  if (groups.length === 0 && store.groups.length > 0) return;
  store.setGroups(groups, syncedAt, incomplete);
  // Drop selections that no longer exist in the loaded list, but keep hand-typed ids
  // (they are held separately in draft.manualGroupIds).
  const live = new Set(groups.map((g) => g.id));
  const kept = [...store.selectedGroupIds].filter((id) => live.has(id));
  if (groups.length > 0 && kept.length !== store.selectedGroupIds.size) {
    store.setSelectedGroups(kept);
  }
}
