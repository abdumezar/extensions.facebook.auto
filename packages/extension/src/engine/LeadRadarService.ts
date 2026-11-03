import type { FbRecipe, Group, Region, SessionTokens } from "@nashir/shared";
import type { AudienceStore } from "./AudienceStore.js";
import { parseActor } from "./audienceParse.js";
import { extractContacts } from "./contactExtract.js";
import { parseFbJson } from "./fbResponse.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";
import { type LeadRule, type ScoredPost, scoreAgainstRules } from "./leadScore.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

export const ALARM_RADAR = "nashir:radar-tick";
export const RADAR_KEY = "nashir:radar:v1";

/**
 * Groups watched per wake.
 *
 * The watch list is capped at 25 groups; this caps the *sweep*, which is the number
 * that actually matters — 25 groups scanned every fifteen minutes is 100 feed reads an
 * hour, which is a third of the hourly `www` budget spent on background work while
 * the operator is trying to run a campaign. Four per wake spreads the same coverage
 * across the hour.
 */
export const GROUPS_PER_TICK = 4;

/** How many posts to look at per group. The feed is chronological; the tail is old. */
export const POSTS_PER_GROUP = 20;

export const RADAR_INTERVAL_MS = 15 * 60 * 1000;

/** Matches kept. Old ones are dropped — this is an inbox, not an archive. */
export const MAX_MATCHES = 200;

export const RADAR_SPACING_MS = DEFAULT_CALL_BUDGET.spacingMs["read.feed"];

export interface LeadMatch {
  id: string;
  groupId: string;
  groupName: string;
  postUrl?: string;
  authorId?: string;
  authorName?: string;
  text: string;
  score: number;
  matched: string[];
  reasons: string[];
  ruleId: string;
  foundAt: number;
  /** Set once the operator has dealt with it. */
  handled?: boolean;
}

export interface RadarConfig {
  enabled: boolean;
  rules: LeadRule[];
  /** Groups to sweep. Capped by the UI; the service caps again. */
  watchedGroupIds: string[];
  /** Fires a desktop notification on a match. */
  notify: boolean;
  lang?: "ar" | "en";
  /**
   * Region for resolving a bare national number out of a post body. Without one,
   * `contactExtract` refuses to guess — which is correct, and which means a radar
   * with no region set silently finds no numbers at all.
   */
  defaultRegion?: Region;
}

interface RadarState {
  config: RadarConfig;
  matches: LeadMatch[];
  /** Post ids already scored, so a post is never notified twice. */
  seen: string[];
  /** Rotating cursor into `watchedGroupIds`, so every group is reached in turn. */
  cursor: number;
  lastSweepAt?: number;
  /** Set when the recipe cannot support a sweep. */
  unsupported?: boolean;
}

const DEFAULT_CONFIG: RadarConfig = {
  enabled: false,
  rules: [],
  watchedGroupIds: [],
  notify: true,
};

const DEFAULT_STATE: RadarState = { config: DEFAULT_CONFIG, matches: [], seen: [], cursor: 0 };

/** Seen-ids kept. Enough to cover a week of sweeps without growing forever. */
const MAX_SEEN = 5_000;

export interface RadarPorts {
  storage: StoragePort;
  http: HttpPort;
  clock: ClockPort;
  logger: LoggerPort;
  audience: AudienceStore;
  /** Fires a desktop notification. Injected so the engine stays free of `chrome.*`. */
  notify: (title: string, message: string, id: string) => Promise<void>;
}

/**
 * LeadRadarService — watch your groups for someone trying to buy.
 *
 * Posting into a group is the easy part; knowing *who to answer* is the hard one. It sweeps a few
 * watched groups per wake, scores each new post with `leadScore` (pure, deterministic,
 * explainable), and notifies on the ones that read as demand rather than supply.
 *
 * Three properties it is built around:
 *
 *  - **Never notify twice.** `seen` is persisted, and a post is scored once. A radar
 *    that re-announces yesterday's post gets muted, and a muted radar is worth nothing.
 *  - **Never outrank the operator.** It is unattended background traffic, so it has
 *    its own slow endpoint class and yields the moment the governor pushes back.
 *  - **Stay deterministic.** The scoring is rule-based and explainable: every match
 *    carries the reasons it scored as it did.
 */
export class LeadRadarService {
  constructor(
    private readonly ports: RadarPorts,
    /** Injected so tests never wait on the pacing, the convention every service here follows. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async getState(): Promise<RadarState> {
    return (await this.ports.storage.get<RadarState>(RADAR_KEY)) ?? DEFAULT_STATE;
  }

  private async save(state: RadarState): Promise<RadarState> {
    await this.ports.storage.set(RADAR_KEY, state);
    return state;
  }

  async configure(patch: Partial<RadarConfig>): Promise<RadarConfig> {
    const state = await this.getState();
    const config = { ...state.config, ...patch };
    await this.save({ ...state, config });
    if (config.enabled) {
      await this.ports.clock.scheduleWake(ALARM_RADAR, Date.now() + RADAR_INTERVAL_MS);
    } else {
      await this.ports.clock.clearWake(ALARM_RADAR);
    }
    return config;
  }

  async matches(): Promise<LeadMatch[]> {
    return (await this.getState()).matches;
  }

  async markHandled(id: string): Promise<void> {
    const state = await this.getState();
    await this.save({
      ...state,
      matches: state.matches.map((m) => (m.id === id ? { ...m, handled: true } : m)),
    });
  }

  async clearMatches(): Promise<void> {
    const state = await this.getState();
    await this.save({ ...state, matches: [] });
  }

  /**
   * One sweep: read a few watched groups, score what is new, notify on the good ones.
   *
   * The cursor rotates, so consecutive wakes cover different groups and every watched
   * group is reached within a few wakes rather than the first four being swept forever.
   */
  async tick(
    tokens: SessionTokens | null,
    recipe: FbRecipe,
    groupsById: Map<string, Group>,
    now: number = Date.now(),
  ): Promise<{ swept: number; found: number; skipped: string | null }> {
    const state = await this.getState();
    if (!state.config.enabled) return { swept: 0, found: 0, skipped: "disabled" };

    if (!recipe.groupFeed?.docId) {
      // The linkPreview contract: a missing doc_id is a reportable state, not an error.
      await this.save({ ...state, unsupported: true });
      await this.rearm();
      return { swept: 0, found: 0, skipped: "unsupported" };
    }
    if (!tokens) {
      await this.rearm();
      return { swept: 0, found: 0, skipped: "no_session" };
    }

    const watched = state.config.watchedGroupIds;
    if (watched.length === 0 || state.config.rules.every((r) => !r.enabled)) {
      await this.rearm();
      return { swept: 0, found: 0, skipped: "nothing_watched" };
    }

    const batch: string[] = [];
    for (let i = 0; i < Math.min(GROUPS_PER_TICK, watched.length); i++) {
      batch.push(watched[(state.cursor + i) % watched.length]!);
    }

    const seen = new Set(state.seen);
    const found: LeadMatch[] = [];
    let swept = 0;

    for (const groupId of batch) {
      if (swept > 0) await this.sleep(RADAR_SPACING_MS);
      let posts: ParsedFeedPost[];
      try {
        posts = await this.readFeed(groupId, tokens, recipe);
      } catch (err) {
        // Facebook or the governor pushed back. Stop the sweep — the remaining groups
        // are swept next wake, and pressing on is how a nudge becomes a block.
        this.ports.logger.warn("Radar sweep stopped early", {
          groupId,
          swept,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      swept++;

      for (const post of posts) {
        if (!post.id || seen.has(post.id)) continue;
        seen.add(post.id);
        if (!post.text) continue;

        const hit = scoreAgainstRules(post.text, groupId, state.config.rules);
        if (!hit) continue;

        found.push(
          this.toMatch(post, groupId, groupsById.get(groupId)?.name ?? groupId, hit, now),
        );

        // A person asking for what you sell, who left a number in the post itself, is
        // the single warmest record this product can produce. Keep it.
        if (post.author) {
          const contacts = extractContacts(post.text, {
            ...(state.config.defaultRegion ? { defaultRegion: state.config.defaultRegion } : {}),
          });
          if (contacts.length > 0) {
            await this.ports.audience.upsert(
              post.author,
              {
                source: "post.commenter",
                postUrl: post.url ?? `https://www.facebook.com/groups/${groupId}`,
                feedbackId: post.id,
                groupId,
                text: post.text,
                capturedAt: now,
              },
              contacts,
              now,
            );
          }
        }
      }
    }

    const merged = [...found, ...state.matches].slice(0, MAX_MATCHES);
    await this.save({
      ...state,
      matches: merged,
      seen: [...seen].slice(-MAX_SEEN),
      cursor: (state.cursor + batch.length) % Math.max(watched.length, 1),
      lastSweepAt: now,
      unsupported: false,
    });

    if (state.config.notify && found.length > 0) {
      // One notification per sweep, not one per match. Four alerts arriving together
      // is how an operator learns to ignore the fifth.
      const best = found.reduce((a, b) => (b.score > a.score ? b : a));
      await this.ports.notify(
        found.length === 1 ? best.groupName : `${found.length} leads`,
        best.text.slice(0, 160),
        best.id,
      );
    }

    await this.rearm();
    return { swept, found: found.length, skipped: null };
  }

  private toMatch(
    post: ParsedFeedPost,
    groupId: string,
    groupName: string,
    hit: { best: ScoredPost; rule: LeadRule },
    now: number,
  ): LeadMatch {
    return {
      id: post.id,
      groupId,
      groupName,
      text: post.text,
      score: hit.best.score,
      matched: hit.best.matched,
      reasons: hit.best.reasons,
      ruleId: hit.rule.id,
      foundAt: now,
      ...(post.url ? { postUrl: post.url } : {}),
      ...(post.author ? { authorId: post.author.id, authorName: post.author.name } : {}),
    };
  }

  private async rearm(): Promise<void> {
    await this.ports.clock.scheduleWake(ALARM_RADAR, Date.now() + RADAR_INTERVAL_MS);
  }

  /** One group's recent feed, through the governed transport. */
  private async readFeed(
    groupId: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
  ): Promise<ParsedFeedPost[]> {
    const q = recipe.groupFeed!;
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
        id: groupId,
        count: POSTS_PER_GROUP,
        cursor: null,
        scale: 1,
        ...(q.staticVars ?? {}),
      }),
    );
    params.set("doc_id", q.docId);

    const res = await this.ports.http.fetch(recipe.endpoints.graphql, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": q.friendlyName,
      },
      body: params.toString(),
    });
    return parseFeed(parseFbJson(await res.text()));
  }
}

// ---------------------------------------------------------------- feed parsing

export interface ParsedFeedPost {
  id: string;
  text: string;
  url?: string;
  author?: { id: string; name: string; profileUrl?: string; profilePicUrl?: string };
}

/**
 * Pull posts out of a group feed response.
 *
 * Written as a tolerant walk rather than a path read for the same reason
 * `audienceParse` is: this doc_id is not captured yet, so the exact nesting is
 * unknown. What is stable across every Facebook feed shape is the leaf — a story node
 * carrying `message.text` and an `actors` array — and that is what this looks for.
 */
export function parseFeed(body: unknown): ParsedFeedPost[] {
  const out: ParsedFeedPost[] = [];
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
    const text = readMessage(o);
    const id = typeof o["post_id"] === "string" ? o["post_id"] : readId(o);
    if (text && id) {
      const actors = o["actors"];
      const author = Array.isArray(actors) ? parseActor(actors[0]) : undefined;
      out.push({
        id,
        text,
        ...(readUrl(o) ? { url: readUrl(o) } : {}),
        ...(author
          ? {
              author: {
                id: author.id,
                name: author.name,
                ...(author.profileUrl ? { profileUrl: author.profileUrl } : {}),
                ...(author.profilePicUrl ? { profilePicUrl: author.profilePicUrl } : {}),
              },
            }
          : {}),
      });
      // Do not descend into a story we have already taken: an attached story would
      // otherwise be reported as a second, phantom post.
      continue;
    }

    for (const v of Object.values(o)) stack.push(v);
  }
  return out;
}

function readMessage(o: Record<string, unknown>): string | undefined {
  const m = o["message"];
  if (m && typeof m === "object" && typeof (m as Record<string, unknown>)["text"] === "string") {
    const text = (m as Record<string, unknown>)["text"] as string;
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function readId(o: Record<string, unknown>): string | undefined {
  for (const key of ["post_id", "legacy_story_hideable_id", "id"]) {
    const v = o[key];
    if (typeof v === "string" && v.length >= 6) return v;
  }
  return undefined;
}

function readUrl(o: Record<string, unknown>): string | undefined {
  for (const key of ["url", "wwwURL", "permalink_url"]) {
    const v = o[key];
    if (typeof v === "string" && v.includes("facebook.com")) return v;
  }
  return undefined;
}
