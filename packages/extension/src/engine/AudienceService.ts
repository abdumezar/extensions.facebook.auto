import type {
  ExtractionState,
  FbRecipe,
  Region,
  SessionTokens,
} from "@nashir/shared";
import type { AudienceStore } from "./AudienceStore.js";
import { extractContacts } from "./contactExtract.js";
import {
  commentSighting,
  findGroupId,
  parseRoster,
  encodeFeedbackTarget,
  findFeedbackId,
  parseComments,
  parsePostUrl,
  parseReactors,
  reactorSighting,
} from "./audienceParse.js";
import { parseFbJson } from "./fbResponse.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

export const EXTRACTION_KEY = "nashir:extraction:v1";

/**
 * Pages to walk per list.
 *
 * The reactor list arrives 50 at a time and a popular group post can carry thousands.
 * `GroupService` learned this the expensive way at 25 pages; 20 here is 1000 reactors,
 * which is more audience than anyone works through in a week, and it is a *cap* rather
 * than a target — most posts finish long before it. Hitting it sets `truncated`, and
 * the UI must say so.
 */
export const MAX_AUDIENCE_PAGES = 20;

/** Reactors per page. Facebook's own dialog asks for 10; 50 is the same call for 5x. */
export const REACTOR_PAGE_SIZE = 50;

/**
 * A roster walk is capped harder than a post walk.
 *
 * A post has a bounded audience; a group has as many members as it has, and the
 * difference between reading 500 of them and reading 50,000 is the difference between
 * a feature and the reason an account is gone.
 */
export const ROSTER_MAX_PAGES = 10;
export const ROSTER_PAGE_SIZE = 50;

/**
 * Gap between pages, from the shared budget so there is one number, not two that drift.
 * The governor enforces it at the transport too; whichever is slower wins.
 */
export const AUDIENCE_PAGE_SPACING_MS = DEFAULT_CALL_BUDGET.spacingMs["read.audience"];

/** A real facebook.com host, as the URL parser sees it — never as a substring. */
export function isFacebookUrl(raw: string): boolean {
  let host: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

const emptyState = (postUrl: string, now: number): ExtractionState => ({
  status: "idle",
  postUrl,
  found: 0,
  withContact: 0,
  reactorPages: 0,
  commentPages: 0,
  startedAt: now,
  truncated: false,
});

export interface ExtractOpts {
  /** Region for resolving bare national numbers. From Settings. */
  defaultRegion?: Region;
  /** Skip the reactor list — it is the expensive half and often the less useful one. */
  skipReactors?: boolean;
  skipComments?: boolean;
  /** Mark sightings as coming from a post we published (Phase 3's loop). */
  own?: boolean;
}

/**
 * AudienceService — who reacted to a post, and who commented on it.
 *
 * Read traffic, which is materially safer than the posting this sits next to, but it
 * is not free: it spends the same app-wide call budget Facebook counts, so every
 * request goes through the injected `HttpPort` (the `GovernedHttp` instance). Calling
 * `fetch` directly here would silently opt the most paginating feature in the product
 * out of the budget — which is precisely the bug the governor was built to end.
 *
 * State is persisted on every page. MV3 evicts the service worker at ~30s idle and an
 * extraction runs for minutes; an in-memory cursor is a cursor that is always lost.
 */
export class AudienceService {
  /** Set by `abort()`, cleared when a run starts. In-memory is enough: one service worker. */
  private aborted = false;

  constructor(
    private readonly store: AudienceStore,
    private readonly storage: StoragePort,
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async state(): Promise<ExtractionState | null> {
    return this.storage.get<ExtractionState>(EXTRACTION_KEY);
  }

  private async save(state: ExtractionState): Promise<ExtractionState> {
    await this.storage.set(EXTRACTION_KEY, state);
    return state;
  }

  /** Ask the running extraction to stop at the next page boundary. */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Resolve a permalink to the feedback id every audience query takes.
   *
   * Facebook addresses a post's audience by its *feedback* id, which is not the post
   * id in the URL and is not derivable from it. The only reliable source is the
   * permalink page itself, so this fetches it and reads the id back out.
   */
  async resolvePost(
    postUrl: string,
    recipe: FbRecipe,
  ): Promise<{ feedbackId?: string; groupId?: string; storyId?: string; error?: string }> {
    // Host first, before anything else looks at this string.
    //
    // The recipe's patterns are substring matches, not host-anchored — they have to be,
    // to cover m./web./www. and the regional hosts. That means a URL like
    // `https://evil.example/?x=facebook.com/groups/a/posts/1` parses as a post, and the
    // next line would fetch it with `credentials: "include"`. Checking the real host
    // through the URL parser is what stops a pasted link becoming a credentialed
    // request to somewhere it should not go.
    if (!isFacebookUrl(postUrl)) return { error: "not_a_post_url" };

    const { storyId, groupId } = parsePostUrl(postUrl, recipe);
    if (!storyId) {
      return { error: "not_a_post_url" };
    }

    let html: string;
    try {
      const res = await this.http.fetch(postUrl, {
        method: "GET",
        credentials: "include",
        headers: { accept: "text/html" },
      });
      html = await res.text();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    // The URL's group segment is usually a vanity slug. The page knows the real id;
    // prefer it so slug-reached and id-reached sightings of one group converge.
    const resolvedGroup = groupId && /^\d+$/.test(groupId) ? groupId : (findGroupId(html) ?? groupId);

    const feedbackId = findFeedbackId(html);
    if (!feedbackId) {
      // Almost always one of: not logged in, no access to the group, or the post is
      // gone. Distinguishing them from the HTML is guesswork, so the caller is told
      // what we could not do rather than why we think we could not.
      return {
        storyId,
        ...(resolvedGroup ? { groupId: resolvedGroup } : {}),
        error: "no_feedback_id",
      };
    }
    return { feedbackId, storyId, ...(resolvedGroup ? { groupId: resolvedGroup } : {}) };
  }

  /**
   * Extract a post's audience into the store.
   *
   * Resumable by construction: state is written after every page, so a service worker
   * eviction mid-walk costs one page, not the run.
   */
  async extract(
    postUrl: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: ExtractOpts = {},
  ): Promise<ExtractionState> {
    this.aborted = false;
    const started = this.now();
    let state = await this.save({ ...emptyState(postUrl, started), status: "resolving" });

    const audience = recipe.postAudience;
    if (!audience?.reactions?.docId || !audience?.comments?.docId) {
      // Same contract as LinkPreviewService: a missing doc_id is a known, reportable
      // state, not an error. The UI says the feature is waiting on a capture.
      return this.save({
        ...state,
        status: "unsupported",
        message: "recipe_missing_post_audience",
        finishedAt: this.now(),
      });
    }

    const resolved = await this.resolvePost(postUrl, recipe);
    if (!resolved.feedbackId) {
      return this.save({
        ...state,
        status: "error",
        message: resolved.error ?? "unresolved",
        finishedAt: this.now(),
      });
    }

    const ctx = {
      postUrl,
      feedbackId: resolved.feedbackId,
      now: started,
      ...(resolved.groupId ? { groupId: resolved.groupId } : {}),
    };
    state = await this.save({
      ...state,
      feedbackId: resolved.feedbackId,
      ...(resolved.groupId ? { groupId: resolved.groupId } : {}),
    });

    try {
      if (!opts.skipReactors) {
        state = await this.walkReactors(state, ctx, tokens, recipe, opts);
      }
      if (!opts.skipComments && !this.aborted) {
        state = await this.walkComments(state, ctx, tokens, recipe, opts);
      }
    } catch (err) {
      // The governor refused, or Facebook did. Everything already written stays —
      // the pages are paid for, and discarding them would spend the budget twice to
      // arrive back here. `GroupService` learned this the same way.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Extraction stopped early", {
        postUrl,
        found: state.found,
        error: message,
      });
      return this.save({
        ...state,
        status: /throttl|cooldown/i.test(message) ? "cooldown" : "error",
        message: message.slice(0, 500),
        truncated: true,
        finishedAt: this.now(),
      });
    }

    return this.save({
      ...state,
      status: this.aborted ? "aborted" : "done",
      truncated: state.truncated || this.aborted,
      finishedAt: this.now(),
    });
  }

  // -------------------------------------------------------------- reactors

  private async walkReactors(
    state: ExtractionState,
    ctx: { postUrl: string; feedbackId: string; groupId?: string; now: number },
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: ExtractOpts,
  ): Promise<ExtractionState> {
    const q = recipe.postAudience!.reactions;
    const target = encodeFeedbackTarget(ctx.feedbackId);
    let cursor: string | undefined;
    let next = state;
    next = await this.save({ ...next, status: "reactors" });

    for (let page = 0; page < MAX_AUDIENCE_PAGES; page++) {
      if (this.aborted) return next;
      if (page > 0) await this.sleep(AUDIENCE_PAGE_SPACING_MS);

      const body = await this.gql(
        q,
        {
          count: REACTOR_PAGE_SIZE,
          cursor: cursor ?? null,
          feedbackTargetID: target,
          // null is the "All" tab — every reaction type in one walk rather than one
          // walk per emoji, which would be seven times the calls for the same people.
          reactionID: null,
          scale: 1,
          id: target,
        },
        tokens,
        recipe,
      );

      const parsed = parseReactors(body);
      for (const r of parsed.items) {
        if (this.aborted) break;
        const written = await this.store.upsert(
          r.actor,
          reactorSighting(r, { ...ctx, now: this.now() }, recipe),
          // A reactor writes no text, so there is nothing to parse a number out of.
          // Their contacts arrive later, if they also comment.
          [],
          this.now(),
        );
        if (written.isNew) next = { ...next, found: next.found + 1 };
      }

      next = await this.save({ ...next, reactorPages: page + 1 });
      if (!parsed.hasNextPage || !parsed.endCursor) return next;
      // A cursor that does not move is a cursor that will page forever.
      if (parsed.endCursor === cursor) return next;
      cursor = parsed.endCursor;

      if (page === MAX_AUDIENCE_PAGES - 1) {
        this.logger.info("Reactor walk hit the page cap", {
          postUrl: ctx.postUrl,
          pages: MAX_AUDIENCE_PAGES,
          found: next.found,
        });
        next = await this.save({ ...next, truncated: true });
      }
    }
    return next;
  }

  // -------------------------------------------------------------- comments

  private async walkComments(
    state: ExtractionState,
    ctx: { postUrl: string; feedbackId: string; groupId?: string; now: number },
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: ExtractOpts,
  ): Promise<ExtractionState> {
    const audience = recipe.postAudience!;
    const target = encodeFeedbackTarget(ctx.feedbackId);
    let next = await this.save({ ...state, status: "comments" });
    let cursor: string | undefined;

    for (let page = 0; page < MAX_AUDIENCE_PAGES; page++) {
      if (this.aborted) return next;
      if (page > 0) await this.sleep(AUDIENCE_PAGE_SPACING_MS);

      // Page one uses the root query; later pages the pagination query, which is the
      // only one that takes a cursor. Without a captured pagination doc_id we get the
      // first page and stop — degraded, not broken.
      const first = page === 0;
      const q = first ? audience.comments : audience.commentsPaging;
      if (!q?.docId) {
        next = await this.save({ ...next, truncated: true });
        return next;
      }

      const vars = first
        ? {
            commentsIntentToken: audience.commentsIntentToken,
            feedLocation: audience.feedLocation,
            feedbackSource: audience.feedbackSource,
            focusCommentID: null,
            scale: 1,
            useDefaultActor: false,
            id: target,
            ...audience.commentProviders,
          }
        : {
            commentsAfterCount: -1,
            commentsAfterCursor: cursor ?? null,
            commentsBeforeCount: null,
            commentsBeforeCursor: null,
            commentsIntentToken: null,
            feedLocation: audience.feedLocation,
            focusCommentID: null,
            scale: 1,
            targetDialect: null,
            useDefaultActor: false,
            id: target,
            ...audience.commentProviders,
          };

      const parsed = parseComments(await this.gql(q, vars, tokens, recipe));
      if (parsed.totalCount !== undefined) {
        next = { ...next, totalComments: parsed.totalCount };
      }

      for (const c of parsed.items) {
        if (this.aborted) break;
        // The whole point of the comment half: the number is in what they typed.
        const contacts = extractContacts(c.text, {
          ...(opts.defaultRegion ? { defaultRegion: opts.defaultRegion } : {}),
        });
        const written = await this.store.upsert(
          c.actor,
          commentSighting(c, { ...ctx, now: this.now(), ...(opts.own ? { own: true } : {}) }, recipe),
          contacts,
          this.now(),
        );
        if (written.isNew) next = { ...next, found: next.found + 1 };
        if (written.gainedContact) next = { ...next, withContact: next.withContact + 1 };
      }

      next = await this.save({ ...next, commentPages: page + 1 });
      if (!parsed.hasNextPage || !parsed.endCursor) return next;
      if (parsed.endCursor === cursor) return next;
      cursor = parsed.endCursor;

      if (page === MAX_AUDIENCE_PAGES - 1) {
        this.logger.info("Comment walk hit the page cap", {
          postUrl: ctx.postUrl,
          pages: MAX_AUDIENCE_PAGES,
          found: next.found,
        });
        next = await this.save({ ...next, truncated: true });
      }
    }
    return next;
  }

  // -------------------------------------------------------------- roster

  /**
   * A group's member roster, or a Page's followers.
   *
   * Deliberately the last thing built and the last thing enabled. It is the same code
   * as the post audience with a different doc_id, but the volumes are two orders of
   * magnitude larger and it is the extraction pattern most associated with account
   * restriction — so it gets a page cap of its own, and the operator has to ask.
   *
   * Page followers additionally may never work: Facebook has progressively restricted
   * that surface, and a captured doc_id is not a promise of coverage. Both report
   * `unsupported` until a doc_id exists, the `linkPreview` contract.
   */
  async extractRoster(
    kind: "group.members" | "page.followers",
    targetId: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
    opts: ExtractOpts & { maxPages?: number } = {},
  ): Promise<ExtractionState> {
    this.aborted = false;
    const started = this.now();
    const label = `${kind}:${targetId}`;
    let state = await this.save({ ...emptyState(label, started), status: "resolving" });

    const q = kind === "group.members" ? recipe.groupMembers : recipe.pageFollowers;
    if (!q?.docId) {
      return this.save({
        ...state,
        status: "unsupported",
        message:
          kind === "group.members" ? "recipe_missing_group_members" : "recipe_missing_page_followers",
        finishedAt: this.now(),
      });
    }

    // A hard cap of its own, lower than the post walk's, because each page here is
    // larger and there is no natural end to a roster.
    const cap = Math.min(opts.maxPages ?? ROSTER_MAX_PAGES, ROSTER_MAX_PAGES);
    let cursor: string | undefined;
    state = await this.save({ ...state, status: "reactors" });

    try {
      for (let page = 0; page < cap; page++) {
        if (this.aborted) break;
        if (page > 0) await this.sleep(AUDIENCE_PAGE_SPACING_MS);

        const body = await this.gql(
          q,
          { id: targetId, count: ROSTER_PAGE_SIZE, cursor: cursor ?? null, scale: 1 },
          tokens,
          recipe,
        );
        const parsed = parseRoster(body);

        for (const actor of parsed.items) {
          if (this.aborted) break;
          const written = await this.store.upsert(
            actor,
            {
              source: "post.reactor",
              postUrl: label,
              feedbackId: targetId,
              ...(kind === "group.members" ? { groupId: targetId } : {}),
              capturedAt: this.now(),
            },
            // A roster carries no text, so there is nothing to parse a number out of.
            [],
            this.now(),
          );
          if (written.isNew) state = { ...state, found: state.found + 1 };
        }

        state = await this.save({ ...state, reactorPages: page + 1 });
        if (!parsed.hasNextPage || !parsed.endCursor || parsed.endCursor === cursor) {
          return this.save({
            ...state,
            status: this.aborted ? "aborted" : "done",
            finishedAt: this.now(),
          });
        }
        cursor = parsed.endCursor;
        if (page === cap - 1) state = await this.save({ ...state, truncated: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Roster extraction stopped early", { kind, targetId, error: message });
      return this.save({
        ...state,
        status: /throttl|cooldown/i.test(message) ? "cooldown" : "error",
        message: message.slice(0, 500),
        truncated: true,
        finishedAt: this.now(),
      });
    }

    return this.save({
      ...state,
      status: this.aborted ? "aborted" : "done",
      truncated: state.truncated || this.aborted,
      finishedAt: this.now(),
    });
  }

  // -------------------------------------------------------------- transport

  /**
   * One governed GraphQL POST, in the shape the rest of the engine uses.
   *
   * `x-fb-friendly-name` is not decoration: it is how `GovernedHttp` classifies the
   * call, so omitting it would bill an audience page as `other` and hide the most
   * paginating feature in the product from the budget it needs to respect.
   */
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
    const text = await res.text();
    const json = parseFbJson(text) as { errors?: Array<{ message?: string }> } | null;

    const errors = json?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const summary = errors
        .map((e) => e.message ?? "")
        .join("; ")
        .slice(0, 240);
      this.logger.warn("Audience query returned errors", {
        friendly: query.friendlyName,
        errorText: summary,
      });
    }
    return json;
  }
}
