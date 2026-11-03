/**
 * FbRecipe — the SINGLE place that encodes Facebook's internal-API shape.
 *
 * Everything Facebook-specific and volatile (endpoints, doc_ids, friendly names,
 * the composer mutation's static variable scaffold + relay-provider flags) lives
 * here. `FacebookClient` is the only consumer. When FB rotates a doc_id or flips a
 * provider flag, this is the one file to update.
 *
 * `shapeVersion` gates changes the client CODE must branch on (structural changes
 * to how the dynamic fields are injected). Pure doc_id / flag / endpoint changes
 * need only a data update at the same shapeVersion.
 *
 * NOTE: this file contains NO session secrets. fb_dtsg / lsd / jazoest / spin
 * tokens / cookies are scraped live per run and never persisted here.
 */

import type { CallBudgetConfig } from "../types/governor.js";

/** JSON-ish value type for the templated variable scaffold. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface FbRecipe {
  /** Monotonic recipe revision. Bump it with every change to the data below. */
  revision: number;
  /** Structural version the FacebookClient must understand. */
  shapeVersion: number;

  endpoints: {
    graphql: string;
    uploadPhoto: string;
    /** Facebook's 3-phase AJAX video upload (start -> chunked transfer -> receive). */
    uploadVideo: {
      start: string;
      transfer: string;
      receive: string;
    };
  };

  /** Group composer post mutation (captured live 2026-08-20, doc_id 27615468271409510). */
  createGroupPost: {
    docId: string;
    friendlyName: string;
    /**
     * Static fields of `variables.input` (everything except the per-post dynamic
     * fields the client injects: message, composed_text, audience, actor_id,
     * logging, client_mutation_id, attachments, scheduling).
     */
    staticInput: Record<string, Json>;
    /** Static top-level `variables` fields (flags + all relay-provider values). */
    topLevel: Record<string, Json>;
  };

  /** Query to load the FIRST page of the user's joined groups. */
  joinedGroups: {
    docId: string;
    friendlyName: string;
  };

  /**
   * Pagination query for "load more" joined groups (Relay connection). Captured by
   * scrolling the Groups page. Until provided, only the first page loads.
   */
  joinedGroupsPagination?: {
    docId: string;
    friendlyName: string;
  };

  /**
   * Dialog Facebook opens before leaving a group (captured live 2026-08-22).
   * Its answer is what tells the user whether leaving merely removes them or
   * DELETES the group — `will_group_delete_when_last_member_leaves` is true for
   * a group the viewer is the last member of, which is how a group is deleted:
   * there is no separate delete mutation, the owner just leaves last.
   */
  leaveGroupDialog?: {
    docId: string;
    friendlyName: string;
  };

  /**
   * Leave-group mutation (captured live 2026-08-22). Also the delete path — see
   * `leaveGroupDialog`. `actionSource` / `readdPolicy` are FB enums kept here so a
   * rotation is a data change, not a code change.
   */
  leaveGroup?: {
    docId: string;
    friendlyName: string;
    /** Surface FB attributes the leave to, e.g. "COMET_GROUP_PAGE". */
    actionSource: string;
    /** Whether members may add the viewer back, e.g. "ALLOW_READD". */
    readdPolicy: string;
  };

  /**
   * Composer link-preview query. NOT captured yet — until a HAR of the composer pasting
   * a link supplies a doc_id, `LinkPreviewService` reports `unsupported` and the UI says
   * so. Attaching links keeps working regardless: Facebook builds the card at post time
   * from the URL alone, so this only affects showing the operator a preview first.
   */
  linkPreview?: {
    docId: string;
    friendlyName: string;
  };

  /**
   * A post's audience: who reacted, and who commented (captured live 2026-08-27).
   *
   * Both lists are read through their *refetch/pagination* query rather than their
   * first-page query. The dialog's own first-page query returns a page sized by
   * whatever the UI wanted; the refetch query takes an explicit `count` and a
   * `cursor`, which is the only shape that can be paged deterministically — so it is
   * used from page one with a null cursor. `reactionsFirst`/`commentsFirst` are kept
   * for documentation and are not on the hot path.
   *
   * `reactionId: null` on the reactions query means "the All tab" — every reaction
   * type at once, rather than one request per emoji.
   */
  postAudience?: {
    /** Paginating reactor list. `variables`: count, cursor, feedbackTargetID, reactionID, scale, id. */
    reactions: { docId: string; friendlyName: string };
    /** First-page reactions dialog query. Documentation only — `reactions` is used from page one. */
    reactionsFirst?: { docId: string; friendlyName: string };
    /** First page of comments. `variables`: commentsIntentToken, feedLocation, feedbackSource, id. */
    comments: { docId: string; friendlyName: string };
    /** Paginating comment list. `variables`: commentsAfterCount, commentsAfterCursor, id. */
    commentsPaging?: { docId: string; friendlyName: string };
    /**
     * Which ordering to ask Facebook for. The chronological-replies intent is what
     * the permalink dialog uses and is the only one that reliably reaches every
     * comment; the "most relevant" default silently hides some.
     */
    commentsIntentToken: string;
    /** Surface FB attributes the read to. Wrong values return an empty connection. */
    feedLocation: string;
    feedbackSource: number;
    /** Relay-provider flags the comment queries require. */
    commentProviders: Record<string, Json>;
    /**
     * Facebook's numeric reaction ids -> a stable English name. Reaction *ids* are
     * what the API returns; the localized name is only present in some responses and
     * is in the viewer's language, which is not a key we can store or export against.
     */
    reactionNames: Record<string, string>;
  };

  /**
   * A group's own feed, for Lead Radar. NOT captured yet — until a HAR of a group
   * page scrolling supplies a doc_id, `LeadRadarService` reports `unsupported` and
   * the UI says so, the same contract `linkPreview` has.
   */
  groupFeed?: {
    docId: string;
    friendlyName: string;
    /** Static `variables` the query needs beyond id/count/cursor. */
    staticVars?: Record<string, Json>;
  };

  /**
   * Posting a comment — the auto first-comment, and a Lead Radar reply. NOT captured.
   *
   * `staticInput` mirrors `createGroupPost`: everything except the per-comment
   * dynamic fields (the target feedback id and the body).
   */
  createComment?: {
    docId: string;
    friendlyName: string;
    staticInput?: Record<string, Json>;
  };

  /** Searching Facebook for groups by keyword, for auto-join. NOT captured. */
  groupSearch?: { docId: string; friendlyName: string };

  /** Joining a group. NOT captured. The most ban-associated action in this category. */
  joinGroup?: { docId: string; friendlyName: string };

  /** A group's member roster. NOT captured — and see the note in the README on why
   * this one is last: same code as the post audience, a hundred times the volume. */
  groupMembers?: { docId: string; friendlyName: string };

  /** A Page's followers. NOT captured, and Facebook has progressively restricted it —
   * expect partial coverage even once a doc_id exists. */
  pageFollowers?: { docId: string; friendlyName: string };

  /**
   * How to read a post permalink. Facebook has at least five shapes for the same post
   * and adds more; keeping them here means a new one is a data change rather
   * than a code change.
   *
   * Each entry is a `RegExp` source string matched against the full URL. Named groups
   * `story` (the post id) and `group` (the owning group, when the shape carries one)
   * are what the client reads — a pattern without a `story` group is ignored rather
   * than throwing, since a bad pattern must not break extraction outright.
   */
  postUrlPatterns?: string[];

  dtsgRefresh?: { url: string };

  tokenExpiredSignals: string[];
  pendingApprovalSignals: string[];
  checkpointSignals: string[];
  /**
   * Errors that mean Facebook is throttling, not that the post was malformed. The
   * rate-limit check (Phase 1c) stops the moment one of these appears — it is the
   * signal the whole check exists to find. Optional so a recipe written
   * before this field existed still loads.
   */
  rateLimitSignals?: string[];

  /**
   * Numeric Facebook error codes, matched against `errors[].code` / `error.code` —
   * NEVER as substrings. A body containing a bare "4" is not a rate limit, and
   * substring-matching numbers here would misclassify half of Facebook's responses.
   *
   * 4 app-too-many-calls, 17 user-too-many-calls, 32 page limit, 341 app limit,
   * 613 custom limit. The 80000-899999 business-use-case range is matched by span,
   * not enumerated.
   */
  rateLimitCodes?: number[];
  /** 368 — a temporary policy block. Hours to days, not minutes. */
  policyBlockCodes?: number[];
  /** 601 — a checkpoint. No wait clears this; only the user can. */
  checkpointCodes?: number[];

  /**
   * Call-budget overrides. Lets a tightening at Facebook be a data change rather
   * than a code change, the same reasoning as every other field here.
   */
  callBudget?: Partial<CallBudgetConfig>;
}

export const DEFAULT_FB_RECIPE: FbRecipe = {
  revision: 6,
  shapeVersion: 1,
  endpoints: {
    graphql: "https://www.facebook.com/api/graphql/",
    uploadPhoto: "https://upload.facebook.com/ajax/react_composer/attachments/photo/upload",
    // Endpoints from the live comet_composer_video_uploader_config (captured 2026-08-21).
    uploadVideo: {
      start: "https://vupload2.facebook.com/ajax/video/upload/requests/start/",
      transfer: "https://vupload2.facebook.com/ajax/video/upload/requests/post/",
      receive: "https://vupload2.facebook.com/ajax/video/upload/requests/receive/",
    },
  },
  createGroupPost: {
    // Current media-capable composer doc_id (captured 2026-08-21; FB rotated from
    // 27615468271409510). Same ComposerStoryCreateMutation — accepts text + attachments.
    docId: "38042645985380374",
    friendlyName: "ComposerStoryCreateMutation",
    staticInput: {
      composer_entry_point: "inline_composer",
      composer_source_surface: "group",
      composer_type: "group",
      source: "WWW",
      with_tags_ids: null,
      inline_activities: [],
      text_format_preset_id: "0",
      group_flair: { flair_id: null },
      tracking: [null],
      event_share_metadata: { surface: "newsfeed" },
    },
    topLevel: {
      feedLocation: "GROUP",
      feedbackSource: 0,
      focusCommentID: null,
      gridMediaWidth: null,
      groupID: null,
      scale: 1,
      privacySelectorRenderLocation: "COMET_STREAM",
      checkPhotosToReelsUpsellEligibility: false,
      referringStoryRenderLocation: null,
      renderLocation: "group",
      useDefaultActor: false,
      inviteShortLinkKey: null,
      isFeed: false,
      isFundraiser: false,
      isFunFactPost: false,
      isGroup: true,
      isEvent: false,
      isTimeline: false,
      isSocialLearning: false,
      isPageNewsFeed: false,
      isProfileReviews: false,
      isWorkSharedDraft: false,
      __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
      __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
      __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
      __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
      __relay_internal__pv__IsWorkUserrelayprovider: false,
      __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
      __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
      __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
      __relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider: false,
      __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
      __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
      __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
      __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
      __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: false,
      __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
      __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
      __relay_internal__pv__IsMergQAPollsrelayprovider: false,
      __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
      __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
      __relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider: false,
      __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: true,
      __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider: 206,
      __relay_internal__pv__StoriesShouldEnablePhotosensitiveContentWarningrelayprovider: false,
      __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider: false,
      __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider: true,
      __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
      __relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider: true,
      __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider: true,
      __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider: false,
    },
  },
  joinedGroups: {
    // Captured live 2026-08-20 from CometGroupsJoinsRoute.
    docId: "24648931168042404",
    friendlyName: "GroupsCometJoinsRootQuery",
  },
  joinedGroupsPagination: {
    // Captured 2026-08-21 from a HAR — the "load more" connection query.
    docId: "9974006939348139",
    friendlyName: "GroupsCometAllJoinedGroupsSectionPaginationQuery",
  },
  leaveGroupDialog: {
    // Captured 2026-08-22 from a HAR of the leave/delete flow.
    docId: "10049188015129417",
    friendlyName: "GroupsCometLeaveDialogQuery",
  },
  leaveGroup: {
    // Captured 2026-08-22 from a HAR of the leave/delete flow.
    docId: "28111003415204547",
    friendlyName: "useGroupLeaveMutation",
    actionSource: "COMET_GROUP_PAGE",
    readdPolicy: "ALLOW_READD",
  },
  postAudience: {
    // Captured 2026-08-27 from a HAR of a group post's reactions dialog and comment
    // thread. The reactions refetch query is the workhorse: 9 of the 11 GraphQL calls
    // in that capture were this one query paging through the reactor list.
    reactions: {
      docId: "37480094514909095",
      friendlyName: "CometUFIReactionsDialogTabContentRefetchQuery",
    },
    reactionsFirst: {
      docId: "27425187170508695",
      friendlyName: "CometUFIReactionsDialogQuery",
    },
    comments: {
      docId: "28454408110916047",
      friendlyName: "CommentListComponentsRootQuery",
    },
    commentsPaging: {
      docId: "28503782072573496",
      friendlyName: "CommentsListComponentsPaginationQuery",
    },
    commentsIntentToken: "RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1",
    feedLocation: "POST_PERMALINK_DIALOG",
    feedbackSource: 2,
    commentProviders: {
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
      __relay_internal__pv__IsWorkUserrelayprovider: false,
    },
    reactionNames: {
      // The five in the capture, read from Facebook's own localized_name fields.
      "1635855486666999": "Like",
      "1678524932434102": "Love",
      "613557422527858": "Care",
      "115940658764963": "Haha",
      "908563459236466": "Sad",
      // Not in the capture — no one used them on that post. These two ids are stable
      // and long-published; an unknown id is reported as its number, never guessed.
      "478547315650144": "Wow",
      "444813342392137": "Angry",
    },
  },
  // Ordered most-specific first: the group rules must beat the generic /<page>/posts/
  // rule, and permalink.php's story_fbid must beat the bare query-param rule.
  //
  // The group segment is `[\w.-]+`, not `\d+`: most groups are reached by a vanity slug
  // (`/groups/examplegroup/posts/…`) and only some by a numeric id. Requiring
  // digits here rejected the majority of real group post links outright.
  //
  // The story segment is `[\w-]+` for the same reason — a group post id is normally
  // numeric but `pfbid…` shows up on shared and cross-posted links.
  postUrlPatterns: [
    String.raw`facebook\.com/groups/(?<group>[\w.-]+)/(?:posts|permalink)/(?<story>[\w-]+)`,
    String.raw`facebook\.com/groups/(?<group>[\w.-]+)/?\?(?:[^#]*&)?multi_permalinks=(?<story>\d+)`,
    String.raw`facebook\.com/permalink\.php\?(?:[^#]*&)?story_fbid=(?<story>\d+)`,
    String.raw`facebook\.com/[^/?#]+/posts/(?<story>[\w-]+)`,
    String.raw`facebook\.com/[^/?#]+/videos/(?<story>\d+)`,
    String.raw`facebook\.com/(?:photo|video)(?:\.php)?\?(?:[^#]*&)?fbid=(?<story>\d+)`,
    String.raw`facebook\.com/share/p/(?<story>[\w-]+)`,
    String.raw`facebook\.com/[^#]*[?&]story_fbid=(?<story>\d+)`,
  ],
  tokenExpiredSignals: [
    "Sorry, something went wrong",
    "please try closing and re-opening",
    "DTSGInitialData",
    "1357004",
  ],
  pendingApprovalSignals: ["pending", "approval", "will be reviewed", "awaiting"],
  checkpointSignals: ["checkpoint", "temporarily blocked", "confirm your identity", "601"],
  rateLimitSignals: [
    "too fast",
    "slow down",
    "rate limit",
    "try again later",
    "You're Temporarily Blocked",
    "temporarily restricted",
    "limit reached",
    "posting too frequently",
    // The copy from the 2026-08-22 incident, verbatim from Facebook's own dialog.
    "too many api requests",
    "there have been too many calls from this app",
    "too many calls",
    "wait a bit and try again",
    "application request limit reached",
    "user request limit reached",
    "please wait a few minutes before you try again",
  ],
  rateLimitCodes: [4, 17, 32, 341, 613],
  policyBlockCodes: [368],
  checkpointCodes: [601],
};
