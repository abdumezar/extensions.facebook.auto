import { z } from "zod";

/**
 * Typed message channel. Two hops:
 *   Dashboard  <-> Service Worker   (UiRequest / UiResponse)
 *   Service Worker <-> Content script (ContentRequest / ContentResponse)
 *
 * Every message is validated at the boundary so a malformed payload fails loudly
 * rather than corrupting engine state.
 */

// ---------- Dashboard -> Service Worker ----------

export const UiRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
  z.object({ type: z.literal("GET_VERSION") }),
  /**
   * Every Facebook operation with the doc_id in force and whether it is the bundled
   * one or one learned from a Facebook tab.
   */
  z.object({ type: z.literal("GET_DOC_IDS") }),
  /** The last known result of the check for a newer release; never touches the network. */
  z.object({ type: z.literal("GET_UPDATE_STATE") }),
  /** Ask GitHub Releases now and return the fresh result. */
  z.object({ type: z.literal("CHECK_FOR_UPDATE") }),

  // Live browser session (no cookie swap): who is logged into Facebook right now.
  z.object({ type: z.literal("GET_SESSION_STATUS") }),
  /**
   * Everything the dashboard needs to be usable on open: who is logged in, their name
   * and photo, and their groups — fetching them if that is what it takes.
   *
   * The one place in the app allowed to open a Facebook tab without the user pressing
   * something labelled as doing that. It is justified because the user just opened the
   * dashboard, the tab is created inactive and closed again, and the alternative is an
   * empty dashboard that makes them go and add their own logged-in account by hand.
   */
  z.object({ type: z.literal("BOOTSTRAP_SESSION") }),

  // Account management
  z.object({ type: z.literal("LIST_ACCOUNTS") }),
  z.object({ type: z.literal("ADD_ACCOUNT_FROM_SESSION") }),
  z.object({ type: z.literal("REMOVE_ACCOUNT"), accountId: z.string() }),
  z.object({ type: z.literal("CHECK_ACCOUNT_HEALTH"), accountId: z.string() }),
  z.object({ type: z.literal("REFRESH_ACCOUNT_PROFILE"), accountId: z.string() }),
  z.object({ type: z.literal("SET_ACCOUNT_LABEL"), accountId: z.string(), label: z.string() }),

  // Groups
  z.object({
    type: z.literal("LOAD_GROUPS"),
    /** Managed account id, or CURRENT_SESSION for the live browser session. */
    accountId: z.string(),
    refresh: z.boolean().optional(),
  }),
  /** Read the cached list without touching Facebook. */
  z.object({ type: z.literal("GET_CACHED_GROUPS"), accountId: z.string() }),
  /**
   * Load groups only if the cache is stale AND a logged-in Facebook tab is already
   * open — the non-intrusive path the dashboard calls on mount.
   */
  z.object({ type: z.literal("SYNC_GROUPS_IF_STALE"), accountId: z.string().optional() }),

  /**
   * Ask Facebook what leaving this group would do BEFORE doing it. The answer is the
   * only thing that distinguishes leaving from deleting — a group the account is the
   * last member of is destroyed by the very same call.
   */
  z.object({ type: z.literal("PREVIEW_LEAVE_GROUP"), accountId: z.string(), groupId: z.string() }),
  /**
   * Leave the given groups, in order, spaced out. Irreversible; the dashboard must have
   * confirmed with the user (and shown the delete warning) before sending this.
   */
  z.object({
    type: z.literal("LEAVE_GROUPS"),
    accountId: z.string(),
    groupIds: z.array(z.string()).min(1),
    /** Seconds between attempts. Omitted = the engine's default spacing. */
    spacingSeconds: z.number().min(0).max(600).optional(),
  }),

  // Phase-1 feasibility spike: post one message to one group as the current session.
  z.object({
    type: z.literal("SPIKE_POST"),
    groupId: z.string(),
    message: z.string(),
    accountId: z.string().optional(),
  }),

  // Campaign control
  z.object({ type: z.literal("START_CAMPAIGN"), campaignId: z.string() }),
  // Persist the given campaign, then start it (campaign validated by the engine).
  z.object({ type: z.literal("RUN_CAMPAIGN"), campaign: z.any() }),
  z.object({ type: z.literal("PAUSE_RUN") }),
  z.object({
    type: z.literal("RESUME_RUN"),
    /**
     * Override a live cooldown. The UI puts a warning in front of this — calling
     * Facebook during a block is the documented way to make the block longer.
     */
    force: z.boolean().optional(),
  }),
  z.object({ type: z.literal("GET_GOVERNOR_SNAPSHOT") }),
  z.object({ type: z.literal("CLEAR_COOLDOWN") }),
  /**
   * "I finished Facebook's security check."
   *
   * Verifies before it clears. A button that simply dropped a checkpoint hold would be
   * a button that walks straight back into the block — and Facebook's own guidance is
   * that calls made during a block extend it. The check reads the DOM of a tab the
   * user already has open, so it costs no Facebook request and works while the
   * governor is refusing everything else.
   */
  z.object({ type: z.literal("RESOLVE_CHECKPOINT") }),
  z.object({ type: z.literal("STOP_RUN") }),
  z.object({ type: z.literal("GET_RUN_SNAPSHOT") }),
  z.object({ type: z.literal("GET_RUN_RESULTS") }),

  // How many facebook.com tabs the user has open (cookie-swap safety check).
  z.object({ type: z.literal("COUNT_FB_TABS") }),

  // ---- Analytics ----
  z.object({
    type: z.literal("GET_ANALYTICS"),
    accountId: z.string().optional(),
    campaignId: z.string().optional(),
    range: z.enum(["24h", "7d", "30d", "all"]).optional(),
  }),
  /** The whole log, serialised for download — never filtered, an export is an archive. */
  z.object({ type: z.literal("EXPORT_ANALYTICS"), format: z.enum(["csv", "json"]) }),
  /** Irreversible: the event log is the only record of past runs. */
  z.object({ type: z.literal("CLEAR_ANALYTICS") }),

  /**
   * Fetch the card Facebook would build for a link. Cosmetic — a link attaches with or
   * without this, so a failure here never blocks a campaign.
   */
  z.object({ type: z.literal("GET_LINK_PREVIEW"), url: z.string().url(), refresh: z.boolean().optional() }),

  // ---- Audience extraction ----
  /**
   * Read a post permalink into the ids the audience queries need, without extracting.
   * The page calls this first so a bad URL is rejected before any budget is spent.
   */
  z.object({ type: z.literal("RESOLVE_POST_URL"), postUrl: z.string().url() }),
  /**
   * Walk a post's reactors and commenters into the local store.
   *
   * Long-running and resumable; the page polls GET_EXTRACTION_STATE rather than
   * waiting on this, so closing the tab does not strand the walk.
   */
  z.object({
    type: z.literal("START_EXTRACTION"),
    postUrl: z.string().url(),
    accountId: z.string().optional(),
    /** Region used to resolve bare national numbers. */
    defaultRegion: z.string().length(2).optional(),
    skipReactors: z.boolean().optional(),
    skipComments: z.boolean().optional(),
  }),
  z.object({ type: z.literal("GET_EXTRACTION_STATE") }),
  z.object({ type: z.literal("ABORT_EXTRACTION") }),
  /** Filtered page of extracted people. */
  z.object({
    type: z.literal("QUERY_AUDIENCE"),
    search: z.string().optional(),
    source: z.enum(["post.reactor", "post.commenter", "own.commenter"]).optional(),
    postUrl: z.string().optional(),
    withContactOnly: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    excludeSuppressed: z.boolean().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  /**
   * Serialise the audience for download. Always excludes suppressed rows: an export
   * is the thing that actually reaches people, so the do-not-contact list has to be
   * applied here and not left to the caller.
   */
  z.object({
    type: z.literal("EXPORT_AUDIENCE"),
    format: z.enum(["csv", "json"]),
    withContactOnly: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  }),
  /** Mark someone contacted, or never-to-be-contacted. Key is a user id or an E.164. */
  z.object({
    type: z.literal("SUPPRESS_CONTACT"),
    id: z.string().min(1),
    reason: z.enum(["contacted", "do_not_contact", "bounced"]),
    note: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("UNSUPPRESS_CONTACT"), id: z.string().min(1) }),
  z.object({ type: z.literal("LIST_SUPPRESSIONS") }),
  /** Irreversible. The extracted people are personal data — deleting must be one click. */
  z.object({ type: z.literal("CLEAR_AUDIENCE"), includeSuppression: z.boolean().optional() }),

  /**
   * Read our own landed posts back into Analytics and the audience store. Off by
   * default: it is background Facebook traffic, and that is the operator's call.
   */
  z.object({
    type: z.literal("CONFIGURE_ENGAGEMENT"),
    enabled: z.boolean().optional(),
    defaultRegion: z.string().length(2).optional(),
  }),
  z.object({ type: z.literal("GET_ENGAGEMENT") }),

  // ---- Lead Radar ----
  z.object({ type: z.literal("GET_RADAR") }),
  z.object({
    type: z.literal("CONFIGURE_RADAR"),
    enabled: z.boolean().optional(),
    notify: z.boolean().optional(),
    lang: z.enum(["ar", "en"]).optional(),
    defaultRegion: z.string().length(2).optional(),
    /** Capped here as well as in the UI: this is recurring unattended traffic. */
    watchedGroupIds: z.array(z.string()).max(25).optional(),
    rules: z
      .array(
        z.object({
          id: z.string(),
          groupIds: z.array(z.string()),
          keywords: z.array(z.string().min(1)).min(1).max(50),
          excludeKeywords: z.array(z.string()).max(50).optional(),
          minScore: z.number().min(0).max(100).optional(),
          enabled: z.boolean(),
          label: z.string().max(100).optional(),
        }),
      )
      .max(20)
      .optional(),
  }),
  z.object({ type: z.literal("MARK_LEAD_HANDLED"), id: z.string() }),
  z.object({ type: z.literal("CLEAR_LEADS") }),

  // ---- Comments (auto first-comment, and Lead Radar replies) ----
  z.object({
    type: z.literal("POST_COMMENT"),
    postUrl: z.string().url(),
    body: z.string().min(1).max(8000),
  }),

  // ---- Group discovery and joining ----
  z.object({ type: z.literal("SEARCH_GROUPS"), keyword: z.string().min(2).max(100) }),
  z.object({
    type: z.literal("JOIN_GROUPS"),
    groupIds: z.array(z.string()).min(1).max(10),
  }),
  z.object({ type: z.literal("GET_JOIN_BUDGET") }),

  // ---- Rosters (group members, page followers) ----
  z.object({
    type: z.literal("EXTRACT_ROSTER"),
    kind: z.enum(["group.members", "page.followers"]),
    targetId: z.string().min(1),
  }),

  // ---- Phase-1 feasibility gate (operator diagnostics) ----
  z.object({ type: z.literal("GET_FEASIBILITY") }),
  /**
   * Run one whole check. Sequencing lives in the service worker, not the page, so a
   * closed dashboard tab cannot strand a half-finished cookie swap.
   */
  z.object({
    type: z.literal("RUN_FEASIBILITY_CHECK"),
    checkId: z.enum(["post", "swap"]),
    groupId: z.string().min(1),
    message: z.string().min(1),
    /** Required by the swap check: the two accounts to round-trip between. */
    accountIdA: z.string().optional(),
    accountIdB: z.string().optional(),
  }),
  /**
   * Start the rate-limit ramp. Real posts at increasing cadence — the dashboard must
   * have taken a typed confirmation naming the throwaway account before sending this.
   */
  z.object({
    type: z.literal("START_RATE_RAMP"),
    accountId: z.string(),
    groupIds: z.array(z.string()).min(1),
    message: z.string().min(1),
    /**
     * Ceilings lowered from 120/hr and a cap of 200.
     *
     * Two posts a minute into Facebook groups does not measure a ceiling, it buys a
     * block — and the block it buys then applies to the operator's real campaigns.
     * Forty an hour is already far above any cadence this app would ship.
     */
    tiers: z
      .array(z.object({ postsPerHour: z.number().min(1).max(40), posts: z.number().min(1).max(50) }))
      .min(1)
      .max(6),
    cap: z.number().min(1).max(60),
  }),
  z.object({ type: z.literal("ABORT_RATE_RAMP") }),
  /** Wipe the record and start the gate over. */
  z.object({ type: z.literal("CLEAR_FEASIBILITY") }),
]);

export type UiRequest = z.infer<typeof UiRequestSchema>;

export const UiResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type UiResponse<T = unknown> = { ok: boolean; data?: T; error?: string };

// ---------- Service Worker -> Content script (runs on facebook.com) ----------

export const ContentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SCRAPE_TOKENS") }),
  z.object({ type: z.literal("READ_C_USER") }),
  z.object({ type: z.literal("CHECK_HEALTH") }),
  z.object({ type: z.literal("SCRAPE_PROFILE") }),
]);
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

export const ContentResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ContentResponse<T = unknown> = { ok: boolean; data?: T; error?: string };

/** Broadcast channel key the SW uses to push run snapshots to the dashboard. */
export const RUN_SNAPSHOT_EVENT = "nashir:run-snapshot";
