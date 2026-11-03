import type {
  FbRecipe,
  Group,
  GroupLeaveOutcome,
  GroupLeavePreview,
  GroupLeaveResult,
  SessionTokens,
} from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";
import type { GroupService } from "./GroupService.js";
import { parseFbJson } from "./fbResponse.js";

/** Default spacing between two leaves in a batch. Leaving is cheap; hammering is not. */
export const DEFAULT_LEAVE_SPACING_MS = 4_000;

/** Stop a batch after this many consecutive rejections — the session is likely dead. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface LeaveOptions {
  /** Milliseconds between attempts in a batch (jittered ±20%). */
  spacingMs?: number;
  /** Override the recipe's re-add policy for this call. */
  readdPolicy?: string;
}

/**
 * GroupLeaveService — leaving a group, and the only way to delete one.
 *
 * Facebook has no "delete group" endpoint. Deleting a group you own is leaving it as
 * its last member: the same `useGroupLeaveMutation` runs, and the group is destroyed
 * server-side. So one call covers both, and the caller cannot know in advance which it
 * is about to do. {@link preview} fetches Facebook's own warning copy so the user is
 * told before confirming; {@link classify} reads the mutation's reply for what actually
 * happened, which is the only reliable signal (a deleted group comes back as null).
 *
 * Both calls are shaped from the recipe (doc_ids captured live 2026-08-22), like every
 * other Facebook-internal call in the engine, so a rotation ships as data.
 *
 * Callers must already be running as the target account — the router wraps managed
 * accounts in `CookieAccountManager.withAccount` before handing tokens in here.
 */
export class GroupLeaveService {
  /** Serial number FB expects per mutation within a session. Monotonic, value unimportant. */
  private mutationSeq = 1;

  constructor(
    private readonly groups: GroupService,
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly rand: () => number = Math.random,
    /**
     * Consulted between groups. Leaving is irreversible, so a batch that runs into a
     * live block must stop with an honest per-group report rather than pushing on and
     * finding out which writes landed afterwards.
     */
    private readonly governor?: { cooldown(): Promise<{ reason: string } | null> },
  ) {}

  /**
   * Ask Facebook what it would warn the user about before leaving this group. A missing
   * field is not an error — it yields the quiet shape (no delete offered, no warning), so
   * the UI can still offer a plain leave; this throws only if the request itself failed.
   */
  async preview(groupId: string, tokens: SessionTokens, recipe: FbRecipe): Promise<GroupLeavePreview> {
    const query = recipe.leaveGroupDialog;
    if (!query) throw new Error("This build has no leave-group dialog query in its recipe.");

    const json = await this.post(recipe, tokens, query, { groupID: groupId });
    const errors = errorText(json);
    if (errors) throw new Error(errors);

    const g = json?.data?.group ?? {};
    const preview: GroupLeavePreview = {
      groupId,
      name: typeof g.name === "string" ? g.name : undefined,
      url: typeof g.url === "string" ? g.url : undefined,
      confirmationTitle: g.viewer_leave_info?.confirmation_title ?? undefined,
      leaveLabel: g.leave_text?.text ?? undefined,
      leaveScenario: g.viewer_leave_info?.leave_scenario ?? undefined,
      visibility: typeof g.visibility === "string" ? g.visibility : undefined,
      deletesGroupWhenLastMemberLeaves: g.will_group_delete_when_last_member_leaves === true,
      canDelete: g.canDelete === true,
    };
    this.logger.info("Leave-group preview", {
      groupId,
      scenario: preview.leaveScenario ?? "(none)",
      deletesWhenLastMemberLeaves: preview.deletesGroupWhenLastMemberLeaves,
      canDelete: preview.canDelete,
    });
    return preview;
  }

  /**
   * Leave one group. On success the group is dropped from `accountId`'s cache, so the
   * dashboard stops listing a group the account can no longer post to.
   */
  async leave(
    accountId: string,
    groupId: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: LeaveOptions = {},
  ): Promise<GroupLeaveResult> {
    const mutation = recipe.leaveGroup;
    const name = await this.cachedName(accountId, groupId);
    if (!mutation) {
      return { groupId, name, outcome: "failed", error: "This build has no leave-group mutation in its recipe." };
    }

    const variables = {
      groupID: groupId,
      input: {
        action_source: mutation.actionSource,
        attribution_id_v2: attribution(),
        group_id: groupId,
        readd_policy: opts.readdPolicy ?? mutation.readdPolicy,
        actor_id: tokens.av,
        client_mutation_id: String(this.mutationSeq++),
      },
      ordering: ["viewer_added"],
      scale: 1,
    };

    let json: any;
    try {
      json = await this.post(recipe, tokens, mutation, variables);
    } catch (err) {
      return { groupId, name, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    const errors = errorText(json);
    if (errors) {
      this.logger.warn("Leave group rejected", { groupId, error: errors.slice(0, 240) });
      return { groupId, name, outcome: "failed", error: errors };
    }

    const outcome = classify(json);
    if (outcome === "failed") {
      return { groupId, name, outcome, error: "Facebook accepted the request but the membership did not change." };
    }

    await this.groups.removeFromCache(accountId, [groupId]);
    this.logger.info(outcome === "deleted" ? "Group deleted by leaving as last member" : "Left group", {
      accountId,
      groupId,
      name,
    });
    return { groupId, name, outcome };
  }

  /**
   * Leave several groups one after another, spaced out and jittered.
   *
   * Sequential on purpose: these are irreversible writes against one session, and a
   * burst of them is exactly the pattern that earns a checkpoint. A run of consecutive
   * rejections aborts the rest as `skipped` rather than grinding through a dead session
   * — the user gets an honest per-group report either way.
   */
  async leaveMany(
    accountId: string,
    groupIds: string[],
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: LeaveOptions = {},
  ): Promise<GroupLeaveResult[]> {
    const spacing = opts.spacingMs ?? DEFAULT_LEAVE_SPACING_MS;
    const results: GroupLeaveResult[] = [];
    let consecutiveFailures = 0;
    let aborted = false;

    for (const [i, groupId] of groupIds.entries()) {
      if (aborted) {
        results.push({
          groupId,
          name: await this.cachedName(accountId, groupId),
          outcome: "skipped",
          error: "Stopped after repeated failures — nothing was attempted for this group.",
        });
        continue;
      }

      // Facebook may have blocked us since the last group — possibly because of this
      // very batch. The remaining groups are reported as skipped, not attempted.
      const cooling = await this.governor?.cooldown();
      if (cooling) {
        aborted = true;
        results.push({
          groupId,
          name: await this.cachedName(accountId, groupId),
          outcome: "skipped",
          error: "Facebook asked us to pause — nothing was attempted for this group.",
        });
        continue;
      }

      if (i > 0 && spacing > 0) await this.sleep(jitter(spacing, this.rand));

      const result = await this.leave(accountId, groupId, tokens, recipe, opts);
      results.push(result);

      if (result.outcome === "failed") {
        consecutiveFailures++;
        // An expired token fails every remaining group identically; stop at once.
        const expired = recipe.tokenExpiredSignals.some((s) => (result.error ?? "").includes(s));
        if (expired || consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) aborted = true;
      } else {
        consecutiveFailures = 0;
      }
    }

    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});
    this.logger.info("Leave-groups batch finished", { accountId, requested: groupIds.length, ...tally });
    return results;
  }

  // ---- internals ----

  /** POST one GraphQL document, form-encoded exactly as Facebook's web client does. */
  private async post(
    recipe: FbRecipe,
    tokens: SessionTokens,
    query: { docId: string; friendlyName: string },
    variables: Record<string, unknown>,
  ): Promise<any> {
    const params = new URLSearchParams();
    params.set("av", tokens.av);
    params.set("__user", tokens.user);
    params.set("__a", "1");
    params.set("dpr", "1");
    params.set("__comet_req", tokens.cometReq);
    params.set("fb_dtsg", tokens.fb_dtsg);
    params.set("jazoest", tokens.jazoest);
    params.set("lsd", tokens.lsd);
    params.set("__spin_r", tokens.spinR);
    params.set("__spin_b", tokens.spinB);
    params.set("__spin_t", tokens.spinT);
    if (tokens.spinR) params.set("__rev", tokens.spinR);
    params.set("__crn", "comet.fbweb.CometGroupsJoinsRoute");
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", query.friendlyName);
    params.set("variables", JSON.stringify(variables));
    params.set("server_timestamps", "true");
    params.set("doc_id", query.docId);

    const res = await this.http.fetch(recipe.endpoints.graphql, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": query.friendlyName,
        "x-fb-lsd": tokens.lsd,
      },
      body: params.toString(),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = parseFbJson(text);
    if (json == null) throw new Error("Unparseable Facebook response");
    return json;
  }

  private async cachedName(accountId: string, groupId: string): Promise<string | undefined> {
    const groups: Group[] = await this.groups.getGroups(accountId);
    return groups.find((g) => g.id === groupId)?.name;
  }
}

/**
 * Read the outcome out of a `group_leave` payload.
 *
 * A deleted group comes back as `group: null` — the node no longer exists, so Relay has
 * nothing to hand back. A surviving group comes back with `is_viewer_member: false`.
 * Anything else (no payload at all, or still a member) is a non-change.
 *
 * A null `group_leave` payload is deliberately NOT read as a delete: it is ambiguous,
 * and reporting an unconfirmed deletion is worse than asking the user to check.
 */
function classify(json: any): GroupLeaveOutcome {
  const payload = json?.data?.group_leave;
  if (payload == null) return "failed";
  if (!("group" in payload)) return "left";
  if (payload.group === null) return "deleted";
  return payload.group?.is_viewer_member === true ? "failed" : "left";
}

function errorText(json: any): string | undefined {
  if (Array.isArray(json?.errors) && json.errors.length) {
    return json.errors.map((e: any) => e.message ?? e.summary ?? "").filter(Boolean).join("; ");
  }
  if (json?.error) return String(json.errorSummary ?? json.error);
  return undefined;
}

/** Telemetry attribution string; FB reads the prefix, the rest is best-effort. */
function attribution(): string {
  return `GroupsCometJoinsRoot.react,comet.groups.joins,unexpected,${Date.now()},666283,,,`;
}

/** ±20% around `ms`, so a batch never lands on a metronome. */
function jitter(ms: number, rand: () => number): number {
  return Math.max(0, Math.round(ms * (1 + (rand() - 0.5) * 0.4)));
}
