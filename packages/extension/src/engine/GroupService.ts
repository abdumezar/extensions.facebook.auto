import type { Group, GroupCache, GroupList, FbRecipe, SessionTokens } from "@nashir/shared";
import type { StoragePort, HttpPort, LoggerPort } from "./ports/index.js";
import { parseFbJson } from "./fbResponse.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";

const groupsKey = (accountId: string) => `nashir:groups:${accountId}`;
const listsKey = (accountId: string) => `nashir:grouplists:${accountId}`;

/** How long a cached group list is considered fresh before an auto-sync refetches it. */
export const GROUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Pages to walk beyond the first in one batch.
 *
 * Was 25. Twenty-six back-to-back GraphQL POSTs with no spacing is the exact traffic
 * shape that earned a "too many calls from this app" block. One batch therefore stays
 * at ten requests; an account with more groups than that holds is finished by further
 * batches, resumed from a saved cursor a couple of minutes apart.
 */
export const MAX_GROUP_PAGES = 9;

/**
 * Requests one walk may spend across all its batches, root query included. Facebook
 * caps memberships at around 6,000 groups, so 70 pages of 100 is past any real account;
 * the cap exists so a cursor that never reports its last page cannot become a source of
 * background traffic that never ends.
 */
export const MAX_TOTAL_GROUP_PAGES = 70;

/**
 * How long a saved cursor is trusted. Relay cursors belong to a session and go stale;
 * past this, the next sync starts again from page one.
 */
export const GROUP_WALK_MAX_AGE_MS = 30 * 60 * 1000;

/** Gap between two batches of the same walk. */
export const GROUP_RESUME_DELAY_MS = 2 * 60 * 1000;

/**
 * Gap between pagination requests, taken from the shared call budget so there is one
 * number rather than two that can drift.
 *
 * The governor enforces this too, at the transport. The two do not stack — it measures
 * from the last call that actually went out, so whichever is slower wins — but pacing
 * here as well keeps the intent legible at the place the burst is generated.
 */
export const GROUP_PAGE_SPACING_MS = DEFAULT_CALL_BUDGET.spacingMs["read.groups"];

/**
 * GroupService — loads the user's joined groups for an account and manages saved lists.
 *
 * Group loading uses the same authenticated-GraphQL path as posting (recipe.joinedGroups).
 * Results are cached per account together with the time they were fetched, so the UI can
 * render instantly from cache and show how stale it is; callers pass `refresh` to re-fetch.
 */
export class GroupService {
  constructor(
    private readonly storage: StoragePort,
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
    /** Injected so tests can assert the pacing without waiting for it. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Cached groups for an account (used by the engine when building a queue). */
  async getGroups(accountId: string): Promise<Group[]> {
    return (await this.getCache(accountId)).groups;
  }

  /** Cached groups plus the moment they were fetched. Never throws; empty means "never synced". */
  async getCache(accountId: string): Promise<GroupCache> {
    const raw = await this.storage.get<GroupCache | Group[]>(groupsKey(accountId));
    // Caches written before syncedAt existed are bare arrays; treat them as ancient.
    if (Array.isArray(raw)) return { accountId, groups: raw, syncedAt: 0 };
    if (raw?.groups) {
      const cache: GroupCache = { accountId, groups: raw.groups, syncedAt: raw.syncedAt ?? 0 };
      if (raw.walk) cache.walk = raw.walk;
      return cache;
    }
    return { accountId, groups: [], syncedAt: 0 };
  }

  /** True when an unfinished walk can still be resumed from its saved cursor. */
  async hasPendingWalk(accountId: string, now: number): Promise<boolean> {
    const { walk } = await this.getCache(accountId);
    return !!walk && now - walk.startedAt <= GROUP_WALK_MAX_AGE_MS;
  }

  /**
   * True when the cache has never been filled, or is older than the TTL.
   *
   * Deliberately keyed off `syncedAt` rather than emptiness. "Empty means stale" looks
   * harmless until a sync legitimately returns nothing — a rotated doc_id, an expired
   * token, an account in no groups — and then the cache is stale forever and every
   * service worker wake re-runs the whole paginated walk against Facebook.
   */
  async isStale(accountId: string, now: number, ttlMs = GROUP_CACHE_TTL_MS): Promise<boolean> {
    const cache = await this.getCache(accountId);
    if (cache.syncedAt === 0) return true;
    return now - cache.syncedAt > ttlMs;
  }

  /**
   * Fetch joined groups from Facebook. Must run while `accountId` is the active session
   * (caller wraps in CookieAccountManager.withAccount) with fresh tokens.
   *
   * One call is one batch of at most `MAX_GROUP_PAGES + 1` requests. When the list is
   * longer than that, the cursor is saved with the cache and the next refresh resumes
   * from it — so a large account converges over a few batches instead of being cut off.
   */
  async loadJoinedGroups(
    accountId: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts?: { refresh?: boolean },
  ): Promise<Group[]> {
    if (!opts?.refresh) {
      const cached = await this.getGroups(accountId);
      if (cached.length > 0) return cached;
    }

    const now = Date.now();
    const previous = await this.getCache(accountId);
    const endpoint = recipe.endpoints.graphql;
    const base = { ordering: ["viewer_added"], scale: 1 };
    const pag = recipe.joinedGroupsPagination;
    const canPage = !!pag && pag.docId !== "0";
    const resuming = canPage && (await this.hasPendingWalk(accountId, now));

    const seen = new Map<string, Group>();
    let cursor: string | undefined;
    let hasNext: boolean;
    let requests: number;
    let startedAt: number;
    let batch = 0;

    if (resuming) {
      const walk = previous.walk!;
      const ids = new Set(walk.seenIds);
      for (const g of previous.groups) if (ids.has(g.id)) seen.set(g.id, g);
      cursor = walk.cursor;
      hasNext = true;
      requests = walk.requests;
      startedAt = walk.startedAt;
    } else {
      const page = await this.fetchPage(recipe.joinedGroups, base, tokens, endpoint);
      for (const g of page.groups) seen.set(g.id, g);
      cursor = page.endCursor;
      hasNext = page.hasNext;
      requests = 1;
      startedAt = now;
      batch = 1;
    }

    // Why the walk stopped. Only "done" means Facebook said there is nothing more.
    let stop: "done" | "batch" | "refused" | "dead" | "total" = "done";
    while (canPage && hasNext && cursor) {
      if (requests >= MAX_TOTAL_GROUP_PAGES) {
        stop = "total";
        break;
      }
      if (batch > MAX_GROUP_PAGES) {
        stop = "batch";
        break;
      }
      // Paced. Every page is a call against a budget Facebook counts app-wide.
      await this.sleep(GROUP_PAGE_SPACING_MS);

      let next: Awaited<ReturnType<GroupService["fetchPage"]>>;
      try {
        next = await this.fetchPage(pag!, { ...base, count: 100, cursor }, tokens, endpoint);
      } catch (err) {
        // The governor refused mid-walk. Keep the pages already paid for and the cursor
        // that was about to be spent, so the next batch starts exactly here rather than
        // paying for all of them again to end up in the same place.
        this.logger.warn("Group pagination stopped early", {
          accountId,
          requests,
          groupsSoFar: seen.size,
          error: err instanceof Error ? err.message : String(err),
        });
        if (seen.size === 0 && !resuming) throw err;
        stop = "refused";
        break;
      }
      requests++;
      batch++;

      const before = seen.size;
      for (const g of next.groups) if (!seen.has(g.id)) seen.set(g.id, g);
      // An error, or a page that added nothing, is a cursor that is dead or stuck.
      // Abandon it: the next scheduled refresh starts again from page one.
      if (next.errored || seen.size === before) {
        stop = "dead";
        break;
      }
      cursor = next.endCursor;
      hasNext = next.hasNext;
    }

    const complete = stop === "done";
    // Until a walk completes, groups it has not reached yet are kept from the previous
    // list — a 1,500-group account must not drop to 910 for the minutes between batches.
    // Only a completed walk is allowed to remove groups the user has left.
    const groups = complete
      ? [...seen.values()]
      : [...seen.values(), ...previous.groups.filter((g) => !seen.has(g.id))];
    const walk =
      (stop === "batch" || stop === "refused") && cursor
        ? { cursor, startedAt, seenIds: [...seen.keys()], requests }
        : undefined;
    if (stop === "total") {
      this.logger.warn("Group walk hit its total page cap", { accountId, requests, groups: seen.size });
    }

    // Never overwrite a good cache with an empty result — a rotated doc_id or an expired
    // token yields zero groups, and blanking the list would silently break every screen.
    //
    // The `syncedAt` stamp still moves. Returning early without it used to leave the
    // cache permanently stale, so every service worker wake re-ran the whole walk: a
    // failing sync became an unbounded source of Facebook traffic.
    if (groups.length === 0 && previous.groups.length > 0) {
      this.logger.warn("Group load returned nothing — keeping the previous cache", {
        accountId,
        cached: previous.groups.length,
      });
      await this.storage.set(groupsKey(accountId), {
        accountId,
        groups: previous.groups,
        syncedAt: Date.now(),
      } satisfies GroupCache);
      return previous.groups;
    }

    const cache: GroupCache = { accountId, groups, syncedAt: Date.now() };
    if (walk) cache.walk = walk;
    await this.storage.set(groupsKey(accountId), cache);
    this.logger.info("Loaded joined groups", {
      accountId,
      count: groups.length,
      requests,
      resumed: resuming,
      stop,
      morePagesRemain: !!walk,
    });
    return groups;
  }

  /** Fetch one page of groups and its pagination cursor. */
  private async fetchPage(
    query: { docId: string; friendlyName: string },
    variables: Record<string, unknown>,
    tokens: SessionTokens,
    endpoint: string,
  ): Promise<{ groups: Group[]; endCursor?: string; hasNext: boolean; errored: boolean }> {
    const params = new URLSearchParams();
    params.set("av", tokens.av);
    params.set("__user", tokens.user);
    params.set("__a", "1");
    params.set("__comet_req", tokens.cometReq);
    params.set("fb_dtsg", tokens.fb_dtsg);
    params.set("jazoest", tokens.jazoest);
    params.set("lsd", tokens.lsd);
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", query.friendlyName);
    params.set("variables", JSON.stringify(variables));
    params.set("doc_id", query.docId);

    const res = await this.http.fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": query.friendlyName,
      },
      body: params.toString(),
    });
    const text = await res.text();
    const json: any = parseFbJson(text);
    const errored = json == null || (Array.isArray(json?.errors) && json.errors.length > 0);
    const errorText = Array.isArray(json?.errors)
      ? json.errors.map((e: any) => e.message ?? e.summary ?? "").join("; ").slice(0, 240)
      : undefined;
    const map = new Map<string, Group>();
    this.collectGroups(json?.data ?? json, map, 0);
    const pi = this.extractPageInfo(json?.data ?? json, 0);
    this.logger.info("FB groups page", {
      friendly: query.friendlyName,
      vars: Object.keys(variables).join(","),
      groups: map.size,
      hasNext: pi.hasNext,
      cursor: pi.endCursor ? pi.endCursor.slice(0, 24) + "…" : "(none)",
      errored,
      errorText,
      bytes: text.length,
    });
    return { groups: [...map.values()], endCursor: pi.endCursor, hasNext: pi.hasNext, errored };
  }

  /** Recursively locate a Relay page_info { end_cursor, has_next_page }. */
  private extractPageInfo(node: any, depth: number): { endCursor?: string; hasNext: boolean } {
    if (!node || typeof node !== "object" || depth > 10) return { hasNext: false };
    if (Array.isArray(node)) {
      for (const it of node) {
        const r = this.extractPageInfo(it, depth + 1);
        if (r.hasNext || r.endCursor) return r;
      }
      return { hasNext: false };
    }
    const pi = node.page_info ?? node.pageInfo;
    if (pi && typeof pi === "object" && ("end_cursor" in pi || "has_next_page" in pi)) {
      return { endCursor: pi.end_cursor ?? pi.endCursor ?? undefined, hasNext: !!(pi.has_next_page ?? pi.hasNextPage) };
    }
    if ("end_cursor" in node || "has_next_page" in node) {
      return { endCursor: (node as any).end_cursor ?? undefined, hasNext: !!(node as any).has_next_page };
    }
    for (const v of Object.values(node)) {
      const r = this.extractPageInfo(v, depth + 1);
      if (r.hasNext || r.endCursor) return r;
    }
    return { hasNext: false };
  }

  /**
   * Drop groups from the cache without a round trip — used after leaving them, so the
   * table stops offering groups the account is no longer in before the next sync.
   * `syncedAt` is left alone: the rest of the list is exactly as fresh as it was.
   */
  async removeFromCache(accountId: string, groupIds: string[]): Promise<Group[]> {
    const drop = new Set(groupIds);
    const cache = await this.getCache(accountId);
    const groups = cache.groups.filter((g) => !drop.has(g.id));
    if (groups.length === cache.groups.length) return cache.groups;
    await this.storage.set(groupsKey(accountId), { ...cache, groups } satisfies GroupCache);
    return groups;
  }

  async savedLists(accountId: string): Promise<GroupList[]> {
    return (await this.storage.get<GroupList[]>(listsKey(accountId))) ?? [];
  }

  async saveList(accountId: string, name: string, groupIds: string[]): Promise<GroupList> {
    const lists = await this.savedLists(accountId);
    const list: GroupList = {
      id: `list_${Date.now()}`,
      accountId,
      name,
      groupIds,
      createdAt: Date.now(),
    };
    await this.storage.set(listsKey(accountId), [...lists, list]);
    return list;
  }

  /**
   * Recursively collect any node that looks like a group — a numeric string `id` plus a
   * `name`, ideally `__typename:"Group"` or a `/groups/` url — and dedupe. Kept tolerant
   * because the exact shape of the groups queries can shift; raw responses are logged.
   */
  private collectGroups(node: any, out: Map<string, Group>, depth: number): void {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) {
      for (const item of node) this.collectGroups(item, out, depth + 1);
      return;
    }
    const id = node.id;
    const name = node.name ?? node.title;
    const looksLikeGroup =
      typeof id === "string" &&
      /^\d{5,}$/.test(id) &&
      typeof name === "string" &&
      name.length > 0 &&
      (node.__typename === "Group" ||
        typeof node.url === "string" && node.url.includes("/groups/") ||
        "group_member_profiles" in node ||
        "viewer_join_state" in node);
    if (looksLikeGroup && !out.has(id)) {
      out.set(id, {
        id,
        name: String(name),
        url: typeof node.url === "string" ? node.url : undefined,
        memberCount: node.group_member_profiles?.count ?? undefined,
      });
    }
    for (const v of Object.values(node)) this.collectGroups(v, out, depth + 1);
  }
}
