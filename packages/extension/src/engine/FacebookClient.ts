import type { FbRecipe, SessionTokens, PostResult, PostStatus } from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";
import { type FbError, fbErrorText, fbErrorsOf, parseFbJson } from "./fbResponse.js";
import { detectThrottle } from "./governorMath.js";
import { ThrottledError } from "./CallGovernor.js";

export interface CreateGroupPostInput {
  groupId: string;
  message: string;
  photoIds?: string[];
  videoIds?: string[];
  linkUrl?: string;
  /** Native FB scheduling, epoch millis. */
  scheduledAt?: number;
  /** Composer session id (stable per campaign run). */
  composerSessionId: string;
}

/**
 * FacebookClient — builds and sends Facebook's INTERNAL GraphQL composer mutation.
 *
 * This is the ONLY module that knows how a group post is shaped. All volatile
 * identifiers (doc_id, friendly name, endpoint) come from the injected FbRecipe,
 * so a Facebook rotation is fixed by shipping a new recipe, not editing this file.
 *
 * The DNR rules (see background/dnrManager) rewrite Origin/Referer on these POSTs
 * so Facebook's CSRF checks pass; here we just send with credentials:'include'.
 */
export class FacebookClient {
  constructor(
    private readonly http: HttpPort,
    private readonly tokens: SessionTokens,
    private readonly recipe: FbRecipe,
    private readonly logger: LoggerPort,
  ) {}

  async createGroupPost(input: CreateGroupPostInput): Promise<PostResult> {
    const startedAt = Date.now();
    try {
      const body = this.buildComposerBody(input);
      const res = await this.http.fetch(this.recipe.endpoints.graphql, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": this.recipe.createGroupPost.friendlyName,
        },
        body: body.toString(),
      });

      const text = await res.text();
      // Evidence for classification tuning — post metadata, not session secrets.
      this.logger.info("FB composer response", { httpOk: res.ok, snippet: text.slice(0, 500) });
      const parsed = this.parseGraphQlResponse(text);
      const latencyMs = Date.now() - startedAt;

      if (!res.ok || parsed.hardError) {
        const errText = parsed.errorText ?? `HTTP ${res.status}`;
        const status: PostStatus = this.matchesSignals(errText, this.recipe.pendingApprovalSignals)
          ? "pending_approval"
          : "failed";
        // Classified from the body we already parsed, so the engine can tell "Facebook
        // refused to consider this post" from "this post was rejected".
        const throttle = detectThrottle(
          { status: res.status, bodyText: text, recipe: this.recipe },
          startedAt,
        );
        return {
          status,
          error: errText,
          latencyMs,
          throttle: throttle.class === "none" ? undefined : throttle,
        };
      }

      const status: PostStatus = parsed.pending ? "pending_approval" : parsed.postId ? "published" : "submitted";
      return {
        status,
        postId: parsed.postId,
        permalink: parsed.postId ? this.permalinkFor(input.groupId, parsed.postId) : undefined,
        latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const latencyMs = Date.now() - startedAt;

      // The governed transport refused before anything left the extension. That is not
      // a failed post — the composer was never asked — so it is reported as a deferral
      // and the engine leaves the job where it is.
      if (err instanceof ThrottledError) {
        return {
          status: "failed",
          error: message,
          latencyMs,
          deferredUntil: err.retryAtMs,
          throttle: err.toVerdict() ?? undefined,
        };
      }

      const throttle = detectThrottle({ bodyText: message, recipe: this.recipe }, startedAt);
      return {
        status: "failed",
        error: message,
        latencyMs,
        throttle: throttle.class === "none" ? undefined : throttle,
      };
    }
  }

  /** True if an error string means the fb_dtsg token is stale (caller should re-scrape + retry once). */
  isTokenExpired(error: string): boolean {
    return this.recipe.tokenExpiredSignals.some((s) => error.includes(s));
  }

  // ---- internals ----

  /**
   * Build the URL-encoded composer request body.
   *
   * The static scaffold (composer flags + all relay-provider values) comes from the
   * recipe — captured live from Facebook's own traffic. Here we inject only the per-post
   * dynamic fields: the message, its Draft.js `composed_text` blocks, the target
   * group, the actor, and optional attachments / scheduling.
   */
  private buildComposerBody(input: CreateGroupPostInput): URLSearchParams {
    const t = this.tokens;
    const recipe = this.recipe.createGroupPost;

    const dynamicInput: Record<string, unknown> = {
      ...recipe.staticInput,
      message: { ranges: [], text: input.message },
      composed_text: this.buildComposedText(input.message),
      logging: { composer_session_id: input.composerSessionId },
      navigation_data: { attribution_id_v2: this.buildAttribution() },
      audience: { to_id: input.groupId },
      actor_id: t.av,
      client_mutation_id: "1",
    };
    const attachments = this.buildAttachments(input);
    if (attachments.length) dynamicInput["attachments"] = attachments;
    if (input.scheduledAt) {
      dynamicInput["publish_time"] = Math.floor(input.scheduledAt / 1000);
      dynamicInput["is_scheduled"] = true;
    }

    const variables = { input: dynamicInput, ...recipe.topLevel };

    const params = new URLSearchParams();
    params.set("av", t.av);
    params.set("__user", t.user);
    params.set("__a", "1");
    params.set("dpr", "1");
    params.set("__comet_req", t.cometReq);
    params.set("fb_dtsg", t.fb_dtsg);
    params.set("jazoest", t.jazoest);
    params.set("lsd", t.lsd);
    params.set("__spin_r", t.spinR);
    params.set("__spin_b", t.spinB);
    params.set("__spin_t", t.spinT);
    if (t.spinR) params.set("__rev", t.spinR);
    params.set("__crn", "comet.fbweb.CometGroupDiscussionRoute");
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", recipe.friendlyName);
    params.set("variables", JSON.stringify(variables));
    params.set("server_timestamps", "true");
    params.set("doc_id", recipe.docId);
    return params;
  }

  /** Draft.js block model FB's composer expects, one block per line of text. */
  private buildComposedText(text: string) {
    const blocks = text.length ? text.split("\n") : [""];
    return {
      block_data: blocks.map(() => "{}"),
      block_depths: blocks.map(() => 0),
      block_types: blocks.map(() => 0),
      blocks,
      entities: blocks.map(() => "[]"),
      entity_map: "{}",
      inline_styles: blocks.map(() => "[]"),
    };
  }

  /** Telemetry attribution string; FB reads the prefix, the rest is best-effort. */
  private buildAttribution(): string {
    const ts = Date.now();
    return `CometGroupDiscussionRoot.react,comet.group,via_cold_start,${ts},516430,2361831622,,`;
  }

  /**
   * Build the composer `attachments` array. Shapes captured live 2026-08-21:
   *   photo → { photo: { id } }
   *   video → { video: { id, audio_descriptions, additional_video_metadata, ... } }
   * Photos and videos can be combined; a link is only used when there's no media.
   */
  private buildAttachments(input: CreateGroupPostInput) {
    const attachments: Array<Record<string, unknown>> = [];
    for (const id of input.photoIds ?? []) attachments.push({ photo: { id } });
    for (const id of input.videoIds ?? []) {
      attachments.push({
        video: {
          audio_descriptions: null,
          id,
          additional_video_metadata: { translatedAudioMetadata: [] },
          notify_when_processed: true,
          transcriptions: null,
          was_created_via_unified_video_flow: null,
        },
      });
    }
    if (attachments.length === 0 && input.linkUrl) attachments.push({ link: { url: input.linkUrl } });
    return attachments;
  }

  /** FB responses may be prefixed with `for (;;);`; may be multi-line JSON. */
  private parseGraphQlResponse(text: string): {
    postId?: string;
    pending: boolean;
    hardError: boolean;
    errorText?: string;
    /** Kept structured so the caller can classify a throttle without re-parsing. */
    errors: FbError[];
  } {
    const json: any = parseFbJson(text);
    if (json == null) {
      return { pending: false, hardError: true, errorText: "Unparseable FB response", errors: [] };
    }

    // Every error shape Facebook uses, codes included — see fbResponse.
    const errors = fbErrorsOf(json);
    if (errors.length) {
      const msg = fbErrorText(errors) ?? "Facebook returned an error";
      const pending = this.matchesSignals(msg, this.recipe.pendingApprovalSignals);
      return { pending, hardError: !pending, errorText: msg, errors };
    }

    // Success shape varies. A real created post id means the post went through; only an
    // EXPLICIT pending flag (not a stray "pending" substring in a moderation field) marks
    // it as awaiting approval. This avoids false "pending" reports for group admins/creators.
    const data = json?.data ?? {};
    const postId = this.extractPostId(data);
    const pending = this.detectExplicitPending(data);
    return { postId, pending, hardError: false, errors: [] };
  }

  /** Prefer an explicit post_id, then a story id — searching known paths then a shallow walk. */
  private extractPostId(data: any): string | undefined {
    const direct = [
      data?.story_create?.story?.post_id,
      data?.story_create?.story?.legacy_story_hideable_id,
      data?.story_create?.story?.id,
      data?.group_composer_publish?.story?.post_id,
      data?.group_composer_publish?.story?.id,
    ].find((c) => typeof c === "string" && c.length > 0);
    return direct ?? this.walkForId(data, 0);
  }

  private walkForId(node: any, depth: number): string | undefined {
    if (!node || typeof node !== "object" || depth > 6) return undefined;
    if (typeof node.post_id === "string" && node.post_id) return node.post_id;
    for (const [k, v] of Object.entries(node)) {
      if (k === "story" && v && typeof (v as any).id === "string" && (v as any).id) return (v as any).id;
      const nested = this.walkForId(v, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }

  /**
   * Detect a GENUINE pending/awaiting-approval state — a specific boolean flag or an
   * approval-status enum, never a bare "pending" substring (which benign group-moderation
   * fields like `pending_stories` or `can_viewer_approve_pending_stories` also contain).
   */
  private detectExplicitPending(node: any, depth = 0): boolean {
    if (!node || typeof node !== "object" || depth > 6) return false;
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase();
      if (
        (key === "is_pending" ||
          key === "pending_approval" ||
          key === "requires_admin_approval" ||
          key === "awaiting_approval") &&
        v === true
      ) {
        return true;
      }
      if (
        (key === "approval_status" || key === "moderation_state" || key === "publish_status") &&
        typeof v === "string" &&
        /pending|review|unapproved|awaiting/i.test(v)
      ) {
        return true;
      }
      if (v && typeof v === "object" && this.detectExplicitPending(v, depth + 1)) return true;
    }
    return false;
  }

  private matchesSignals(text: string, signals: string[]): boolean {
    const t = text.toLowerCase();
    return signals.some((s) => t.includes(s.toLowerCase()));
  }

  private permalinkFor(groupId: string, postId: string): string {
    return `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
  }
}
