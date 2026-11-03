import type { FbRecipe, Group, SessionTokens } from "@nashir/shared";
import { fbErrorText, fbErrorsOf, parseFbJson } from "./fbResponse.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

export const JOIN_KEY = "nashir:joins:v1";

/**
 * Joins allowed per rolling day.
 *
 * Joining is the single most restriction-associated action in Facebook automation —
 * more than posting, because a burst of joins is what an account takeover looks like.
 * Eight a day is roughly what an enthusiastic human does and is far below any rate
 * that would make this feature the reason an account is lost.
 */
export const MAX_JOINS_PER_DAY = 8;

/** Joins per batch. The daily cap is the real limit; this stops one sitting spending it. */
export const MAX_JOINS_PER_BATCH = 3;

export const JOIN_SPACING_MS = DEFAULT_CALL_BUDGET.spacingMs["mutation.join"];

export type JoinStatus = "joined" | "requested" | "failed" | "skipped" | "unsupported";

export interface JoinResult {
  groupId: string;
  status: JoinStatus;
  error?: string;
}

interface JoinLog {
  /** Epoch-ms of every join attempt that actually reached Facebook. */
  at: number[];
}

/**
 * GroupJoinService — find groups worth posting in, and join them at a survivable pace.
 *
 * Symmetric with `GroupLeaveService`, and built the same way: batched, spaced,
 * jittered, aborting on repeated failure or a live cooldown. The differences are all
 * in the direction of caution, because leaving a group has never got an account
 * restricted and joining several dozen has.
 *
 * `groupSearch` and `joinGroup` doc_ids are not captured yet, so both halves report
 * `unsupported` until a HAR supplies them — the `linkPreview` contract.
 */
export class GroupJoinService {
  constructor(
    private readonly storage: StoragePort,
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  searchSupported(recipe: FbRecipe): boolean {
    return !!recipe.groupSearch?.docId;
  }

  joinSupported(recipe: FbRecipe): boolean {
    return !!recipe.joinGroup?.docId;
  }

  /** How many joins are still allowed today. */
  async remainingToday(): Promise<number> {
    const log = (await this.storage.get<JoinLog>(JOIN_KEY)) ?? { at: [] };
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    return Math.max(0, MAX_JOINS_PER_DAY - log.at.filter((t) => t > cutoff).length);
  }

  private async record(): Promise<void> {
    const log = (await this.storage.get<JoinLog>(JOIN_KEY)) ?? { at: [] };
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    await this.storage.set(JOIN_KEY, {
      at: [...log.at.filter((t) => t > cutoff), this.now()],
    });
  }

  /**
   * Search Facebook for groups matching a keyword.
   *
   * Read-only and cheap; the expensive, risky half is joining what it finds, which is
   * deliberately a separate call the operator makes after looking at the results.
   */
  async search(
    keyword: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<{ groups: Group[]; unsupported?: boolean }> {
    const q = recipe.groupSearch;
    if (!q?.docId) return { groups: [], unsupported: true };

    const json = await this.gql(
      q,
      { count: 20, cursor: null, query: keyword, scale: 1 },
      tokens,
      recipe,
    );
    return { groups: collectGroups(json) };
  }

  /**
   * Join the given groups, in order, spaced out, within the daily cap.
   *
   * Stops at the first cooldown rather than working through the list: the whole point
   * of the cap is that the marginal join is never worth the account.
   */
  async join(
    groupIds: string[],
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<JoinResult[]> {
    const q = recipe.joinGroup;
    if (!q?.docId) {
      return groupIds.map((groupId) => ({
        groupId,
        status: "unsupported" as const,
        error: "recipe_missing_join_group",
      }));
    }

    const results: JoinResult[] = [];
    const batch = groupIds.slice(0, MAX_JOINS_PER_BATCH);

    for (const groupId of batch) {
      const remaining = await this.remainingToday();
      if (remaining <= 0) {
        // Everything left is skipped, and said so — a silent stop reads as success.
        results.push(
          ...groupIds
            .slice(results.length)
            .map((id) => ({ groupId: id, status: "skipped" as const, error: "daily_cap" })),
        );
        this.logger.info("Join batch stopped at the daily cap", { done: results.length });
        return results;
      }

      if (results.length > 0) await this.sleep(JOIN_SPACING_MS);

      try {
        const json = await this.gql(q, { input: { group_id: groupId, source: "groups_tab" } }, tokens, recipe);
        await this.record();
        const errors = fbErrorsOf(json);
        if (errors.length > 0) {
          results.push({ groupId, status: "failed", ...(fbErrorText(errors) ? { error: fbErrorText(errors)! } : {}) });
          // Two consecutive failures usually means Facebook has started refusing, not
          // that these two groups are unusual.
          if (results.filter((r) => r.status === "failed").length >= 2) {
            this.logger.warn("Join batch aborted after repeated failures", { groupId });
            break;
          }
          continue;
        }
        // A closed group answers a join with a *request*, not a membership, and the
        // two must not be conflated: the operator's group list would otherwise show
        // groups they cannot post to.
        results.push({ groupId, status: joinState(json) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Join failed", { groupId, error: message });
        results.push({ groupId, status: "failed", error: message });
        break;
      }
    }

    for (const id of groupIds.slice(results.length)) {
      results.push({ groupId: id, status: "skipped", error: "batch_limit" });
    }
    return results;
  }

  private async gql(
    query: { docId: string; friendlyName: string },
    variables: Record<string, unknown>,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<unknown> {
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

    const res = await this.http.fetch(recipe.endpoints.graphql, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": query.friendlyName,
      },
      body: params.toString(),
    });
    return parseFbJson(await res.text());
  }
}

/** `joined` vs `requested`, read off whatever join-state field the response carries. */
export function joinState(body: unknown): "joined" | "requested" {
  const seen = new Set<unknown>();
  const stack: unknown[] = [body];
  let budget = 50_000;
  while (stack.length > 0 && budget-- > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const o = cur as Record<string, unknown>;
    const state = o["join_state"] ?? o["viewer_join_state"] ?? o["request_to_join_state"];
    if (typeof state === "string") {
      if (/MEMBER|JOINED/i.test(state)) return "joined";
      if (/REQUEST|PENDING/i.test(state)) return "requested";
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  // Unknown reads as `requested`: the cautious answer, since treating a pending
  // request as membership puts an unpostable group into the campaign list.
  return "requested";
}

/**
 * Groups out of a search response.
 *
 * The same tolerant shape-test `GroupService.collectGroups` uses — a long numeric id
 * plus a name plus something that marks it as a group — because the search doc_id is
 * not captured and the exact nesting is unknown.
 */
export function collectGroups(body: unknown): Group[] {
  const out = new Map<string, Group>();
  const seen = new Set<unknown>();
  const stack: unknown[] = [body];
  let budget = 200_000;

  while (stack.length > 0 && budget-- > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const o = cur as Record<string, unknown>;
    const id = o["id"];
    const name = o["name"];
    const url = typeof o["url"] === "string" ? o["url"] : undefined;
    const isGroup =
      o["__typename"] === "Group" ||
      "viewer_join_state" in o ||
      (url?.includes("/groups/") ?? false);

    if (typeof id === "string" && /^\d{5,}$/.test(id) && typeof name === "string" && name && isGroup) {
      const members = o["member_count"] ?? o["group_member_profiles"];
      out.set(id, {
        id,
        name,
        url: url ?? `https://www.facebook.com/groups/${id}`,
        ...(typeof members === "number" ? { memberCount: members } : {}),
      } as Group);
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return [...out.values()];
}
