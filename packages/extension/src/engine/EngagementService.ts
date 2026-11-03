import type { FbRecipe, PostEvent, Region, SessionTokens } from "@nashir/shared";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { AudienceService } from "./AudienceService.js";
import type { ClockPort, LoggerPort, StoragePort } from "./ports/index.js";

export const ALARM_ENGAGEMENT = "nashir:engagement-tick";
export const ENGAGEMENT_KEY = "nashir:engagement:v1";

/**
 * How long after a post lands before it is worth reading back.
 *
 * Immediately is useless — nobody has seen it — and the reactions on a group post keep
 * arriving for a day or more. Six hours is the first point where the number means
 * something, and it is also late enough that a check never collides with the campaign
 * that produced the post still running.
 */
export const FIRST_CHECK_DELAY_MS = 6 * 60 * 60 * 1000;

/** A post is read back at most twice: once early, once when it has settled. */
export const SECOND_CHECK_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

/** Posts read per wake. Small on purpose — this is background work nobody is watching. */
export const POSTS_PER_TICK = 3;

/** Gap between wakes. */
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

interface Checked {
  /** permalink -> the checks already done for it. */
  [permalink: string]: { first?: number; second?: number };
}

export interface EngagementConfig {
  enabled: boolean;
  /** Region for parsing numbers out of the comments on our own posts. */
  defaultRegion?: Region;
}

interface EngagementState {
  config: EngagementConfig;
  checked: Checked;
}

const DEFAULT_STATE: EngagementState = { config: { enabled: false }, checked: {} };

/**
 * EngagementService — close the loop on our own posts.
 *
 * Every number on the Analytics page today comes from what Nashir *sent*. That answers
 * "did the post go out" and cannot answer "did it work", which is the only question
 * that decides where the next campaign should post. This reads our own posts back:
 * who reacted, who commented, and — because a commenter on your own ad is the warmest
 * lead in the product — their contact details, straight into the audience store.
 *
 * Deliberately cheap and deliberately off by default. It reuses `AudienceService`
 * wholesale, so it costs no new recipe entries and no new endpoint class, and it runs
 * on its own slow alarm well behind the campaign loop it follows.
 */
export class EngagementService {
  constructor(
    private readonly analytics: AnalyticsStore,
    private readonly audience: AudienceService,
    private readonly storage: StoragePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  async getState(): Promise<EngagementState> {
    return (await this.storage.get<EngagementState>(ENGAGEMENT_KEY)) ?? DEFAULT_STATE;
  }

  async configure(config: Partial<EngagementConfig>): Promise<EngagementConfig> {
    const state = await this.getState();
    const next = { ...state, config: { ...state.config, ...config } };
    await this.storage.set(ENGAGEMENT_KEY, next);
    if (next.config.enabled) {
      await this.clock.scheduleWake(ALARM_ENGAGEMENT, Date.now() + TICK_INTERVAL_MS);
    } else {
      await this.clock.clearWake(ALARM_ENGAGEMENT);
    }
    return next.config;
  }

  /**
   * Posts that are due a read-back, oldest first.
   *
   * Only `published` events with a permalink qualify. A post still awaiting admin
   * approval has no audience to read, and a failed one has no post.
   */
  async due(now: number): Promise<Array<{ event: PostEvent; which: "first" | "second" }>> {
    const state = await this.getState();
    const events = await this.analytics.all();
    const out: Array<{ event: PostEvent; which: "first" | "second" }> = [];

    for (const e of events) {
      if (e.status !== "published" || !e.permalink) continue;
      const done = state.checked[e.permalink] ?? {};
      const age = now - e.ts;
      if (!done.first && age >= FIRST_CHECK_DELAY_MS) {
        out.push({ event: e, which: "first" });
      } else if (done.first && !done.second && age >= SECOND_CHECK_DELAY_MS) {
        out.push({ event: e, which: "second" });
      }
    }
    return out.sort((a, b) => a.event.ts - b.event.ts);
  }

  /**
   * One wake: read back a few posts, then schedule the next.
   *
   * Tokens come from a Facebook tab the user already has open and are never obtained
   * by opening one. This is unattended background work — it must be invisible, and a
   * tab appearing on its own is the opposite of invisible.
   */
  async tick(
    getTokens: () => Promise<SessionTokens | null>,
    getRecipe: () => Promise<FbRecipe>,
    now: number = Date.now(),
  ): Promise<{ checked: number; skipped: string | null }> {
    const state = await this.getState();
    if (!state.config.enabled) return { checked: 0, skipped: "disabled" };

    const batch = (await this.due(now)).slice(0, POSTS_PER_TICK);
    if (batch.length === 0) {
      await this.rearm();
      return { checked: 0, skipped: "nothing_due" };
    }

    const tokens = await getTokens();
    if (!tokens) {
      // No open Facebook tab. Try again next hour rather than opening one.
      await this.rearm();
      return { checked: 0, skipped: "no_session" };
    }

    const recipe = await getRecipe();
    let checked = 0;

    for (const item of batch) {
      const permalink = item.event.permalink!;
      try {
        const result = await this.audience.extract(permalink, tokens, recipe, {
          ...(state.config.defaultRegion ? { defaultRegion: state.config.defaultRegion } : {}),
          // Marks the sightings as coming from our own post, which is what lets the
          // audience table separate "someone who engaged with my ad" from "someone I
          // scraped off a stranger's post".
          own: true,
        });
        // A cooldown means Facebook asked us to stop. Stop — and do not mark the post
        // checked, so it is retried rather than silently skipped forever.
        if (result.status === "cooldown") {
          this.logger.info("Engagement loop yielding to a cooldown", { permalink });
          break;
        }
        checked++;
        await this.markChecked(permalink, item.which, now);
      } catch (err) {
        this.logger.warn("Engagement read-back failed", {
          permalink,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    await this.rearm();
    return { checked, skipped: null };
  }

  private async markChecked(permalink: string, which: "first" | "second", now: number): Promise<void> {
    const state = await this.getState();
    const entry = state.checked[permalink] ?? {};
    entry[which] = now;
    await this.storage.set(ENGAGEMENT_KEY, {
      ...state,
      checked: { ...state.checked, [permalink]: entry },
    });
  }

  private async rearm(): Promise<void> {
    await this.clock.scheduleWake(ALARM_ENGAGEMENT, Date.now() + TICK_INTERVAL_MS);
  }
}
