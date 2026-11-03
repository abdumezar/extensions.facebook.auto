import type { FbRecipe, SessionTokens } from "@nashir/shared";
import { encodeFeedbackTarget, findFeedbackId } from "./audienceParse.js";
import { fbErrorText, fbErrorsOf, parseFbJson } from "./fbResponse.js";
import type { HttpPort, LoggerPort } from "./ports/index.js";

/** What a comment attempt did. Mirrors `PostStatus`'s honesty about partial success. */
export type CommentStatus = "posted" | "failed" | "unsupported";

export interface CommentResult {
  status: CommentStatus;
  commentId?: string;
  error?: string;
}

/**
 * CommentService — post a comment on a post we can address.
 *
 * Two callers, one mechanism:
 *
 *  - **Auto first-comment.** The link or contact detail belongs in the first comment,
 *    not the post body: Facebook demotes posts carrying outbound links, and the
 *    comment is where responders reply anyway.
 *  - **Lead Radar replies.** Answering the buyer in the thread they asked in.
 *
 * Deliberately NOT wired into `CampaignEngine`'s post path inline. A comment is a
 * separate unit of work with its own governed spacing and its own retry: folding it
 * into the post would make one failure look like the other, and would spend a
 * `mutation.comment` slot inside a `mutation.post` slot.
 *
 * The doc_id is not captured yet, so this reports `unsupported` until a HAR supplies
 * one — the same contract `linkPreview` and `AudienceService` have.
 */
export class CommentService {
  constructor(
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
  ) {}

  /** True when the recipe can support commenting at all. */
  supported(recipe: FbRecipe): boolean {
    return !!recipe.createComment?.docId;
  }

  /**
   * Comment on a post, addressed by its permalink.
   *
   * Resolving the permalink to a feedback id is the same problem `AudienceService`
   * solves, and the same solution: fetch the page, read the id out. Shared through
   * `audienceParse` rather than duplicated, so a change to Facebook's page shape is
   * one fix and not two.
   */
  async comment(
    postUrl: string,
    body: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<CommentResult> {
    const q = recipe.createComment;
    if (!q?.docId) return { status: "unsupported", error: "recipe_missing_create_comment" };
    if (!body.trim()) return { status: "failed", error: "empty_body" };

    let feedbackId: string | undefined;
    try {
      const res = await this.http.fetch(postUrl, {
        method: "GET",
        credentials: "include",
        headers: { accept: "text/html" },
      });
      feedbackId = findFeedbackId(await res.text());
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (!feedbackId) return { status: "failed", error: "no_feedback_id" };

    return this.commentOnFeedback(feedbackId, body, tokens, recipe);
  }

  /** The same, when the caller already holds a feedback id (Lead Radar, the loop). */
  async commentOnFeedback(
    feedbackId: string,
    body: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<CommentResult> {
    const q = recipe.createComment;
    if (!q?.docId) return { status: "unsupported", error: "recipe_missing_create_comment" };

    const target = encodeFeedbackTarget(feedbackId);
    const params = new URLSearchParams();
    params.set("av", tokens.av);
    params.set("__user", tokens.user);
    params.set("__a", "1");
    params.set("__comet_req", tokens.cometReq);
    params.set("fb_dtsg", tokens.fb_dtsg);
    params.set("jazoest", tokens.jazoest);
    params.set("lsd", tokens.lsd);
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", q.friendlyName);
    params.set(
      "variables",
      JSON.stringify({
        input: {
          // The composer sends the body as a Draft.js-style message, the same shape
          // `FacebookClient` builds for a post.
          message: { ranges: [], text: body },
          feedback_id: target,
          feedback_source: "OBJECT",
          is_tracking_encrypted: true,
          attachments: null,
          actor_id: tokens.av,
          client_mutation_id: String(Date.now()),
          ...(q.staticInput ?? {}),
        },
        feedLocation: "PERMALINK",
        scale: 1,
      }),
    );
    params.set("doc_id", q.docId);

    let text: string;
    try {
      const res = await this.http.fetch(recipe.endpoints.graphql, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": q.friendlyName,
        },
        body: params.toString(),
      });
      text = await res.text();
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    const json = parseFbJson(text);
    const errors = fbErrorsOf(json);
    if (errors.length > 0) {
      const message = fbErrorText(errors);
      this.logger.warn("Comment failed", { friendly: q.friendlyName, errorText: message });
      return { status: "failed", ...(message ? { error: message } : {}) };
    }

    const commentId = findCommentId(json);
    // No id in the response is NOT a success. Facebook returns 200 with a null
    // payload when a comment is silently dropped (a blocked link, a muted thread),
    // and reporting that as posted would tell the operator their link went out when
    // nobody will ever see it.
    if (!commentId) return { status: "failed", error: "no_comment_id_in_response" };

    this.logger.info("Comment posted", { feedbackId, commentId });
    return { status: "posted", commentId };
  }
}

/** Walk the mutation response for the created comment's id. */
export function findCommentId(body: unknown): string | undefined {
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
    if (o["__typename"] === "Comment") {
      const id = o["id"] ?? o["legacy_fbid"];
      if (typeof id === "string" && id.length > 0) return id;
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return undefined;
}
