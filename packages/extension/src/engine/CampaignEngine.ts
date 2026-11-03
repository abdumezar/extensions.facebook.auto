import type {
  Campaign,
  RunState,
  RunSnapshot,
  PostJob,
  PostResult,
  FbRecipe,
  Account,
} from "@nashir/shared";
import type { StoragePort, ClockPort, LoggerPort } from "./ports/index.js";
import { FacebookClient } from "./FacebookClient.js";
import { TokenScraper } from "./TokenScraper.js";
import { CookieAccountManager } from "./CookieAccountManager.js";
import type { CommentService } from "./CommentService.js";
import type { GroupService } from "./GroupService.js";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { ImageUploadService } from "./ImageUploadService.js";
import type { VideoUploadService } from "./VideoUploadService.js";
import type { MediaStore } from "./MediaStore.js";
import {
  nextDelayMs,
  shouldSafetyBreak,
  backoffAfterFailure,
  dayKey,
  dailyBudgetRemaining,
} from "./SafetyPolicy.js";
import type { HttpPort } from "./ports/index.js";
import type { CallGovernor } from "./CallGovernor.js";
import { detectThrottle, opensCooldown } from "./governorMath.js";

const RUN_KEY = "nashir:run";
export const ALARM_TICK = "nashir:tick";

/**
 * How many times one job may be pushed back by Facebook before the run gives up and
 * waits for a person.
 *
 * A cooldown that keeps re-arming means the block is not clearing on the schedule we
 * guessed, and continuing to poke at it is the documented way to make it worse.
 */
const MAX_THROTTLE_DEFERRALS = 5;

export interface CampaignEngineDeps {
  storage: StoragePort;
  clock: ClockPort;
  logger: LoggerPort;
  http: HttpPort;
  accounts: CookieAccountManager;
  scraper: TokenScraper;
  groups: GroupService;
  analytics: AnalyticsStore;
  images: ImageUploadService;
  videos: VideoUploadService;
  media: MediaStore;
  /**
   * Optional so every existing test constructs the engine unchanged. Without it the
   * campaign's first comment is simply never attempted, which is also the correct
   * behaviour for a build whose recipe has no create-comment doc_id.
   */
  comments?: CommentService;
  getRecipe: () => Promise<FbRecipe>;
  governor: CallGovernor;
  /** 0..1 source for the retry jitter, mirroring `SafetyPolicy`'s injected `rand`. */
  rand?: () => number;
}

/**
 * CampaignEngine — owns the persisted, alarm-driven posting loop.
 *
 * Design invariants:
 *  - All progress lives in a single persisted RunState. Each alarm fires exactly one
 *    `tick`, which does at most one unit of work, then schedules the next wake.
 *  - `tick` is idempotent and guarded by RunState.locked, so a service worker eviction
 *    mid-run is transparent: the next alarm re-hydrates state and continues.
 *  - Cookie swap happens BEFORE token scraping (tokens are per-session).
 */
export class CampaignEngine {
  constructor(private readonly d: CampaignEngineDeps) {}

  async getState(): Promise<RunState | null> {
    return this.d.storage.get<RunState>(RUN_KEY);
  }

  async getSnapshot(): Promise<RunSnapshot | null> {
    const s = await this.getState();
    if (!s) return null;
    const done = s.results.length;
    const published = s.results.filter((r) => r.status === "published").length;
    const pending = s.results.filter((r) => r.status === "pending_approval").length;
    const failed = s.results.filter((r) => r.status === "failed").length;
    const lastJob = s.queue[Math.max(0, s.cursor - 1)];
    return {
      runId: s.runId,
      status: s.status,
      total: s.queue.length,
      done,
      published,
      pending,
      failed,
      lastGroupName: lastJob?.groupName,
      nextWakeAt: s.nextWakeAt,
      activeAccountId: s.activeAccountId,
      cooldownUntil: s.cooldownUntil,
      cooldownReason: s.cooldownReason,
      cooldownClass: s.cooldownClass,
      requiresOperator: s.requiresOperator,
      // Used to be recorded on RunState and then never shown anywhere.
      errorMessage: s.errorMessage,
    };
  }

  /** Build the queue and start a run. */
  async start(campaign: Campaign): Promise<RunState> {
    const queue = await this.buildQueue(campaign);
    if (queue.length === 0) throw new Error("Campaign produced an empty queue (no accounts/groups?).");

    const now = this.d.clock.now();
    const state: RunState = {
      runId: `run_${now}`,
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: "running",
      queue,
      cursor: 0,
      nextWakeAt: now, // first post starts immediately
      postsSinceBreak: 0,
      consecutiveFailures: 0,
      perAccountCounts: {},
      activeAccountId: null,
      results: [],
      locked: false,
      startedAt: now,
      updatedAt: now,
    };
    await this.persist(state);
    await this.d.clock.scheduleWake(ALARM_TICK, now);
    this.d.logger.info("Run started", { runId: state.runId, jobs: queue.length });
    return state;
  }

  async pause(): Promise<void> {
    const s = await this.getState();
    if (!s || s.status === "done") return;
    s.status = "paused";
    await this.persist(s);
    await this.d.clock.clearWake(ALARM_TICK);
  }

  /**
   * Resume a paused, broken or cooled-down run.
   *
   * `force` is the operator overriding a live cooldown. It exists because a person may
   * know something we do not, but it is deliberately not the default: calling Facebook
   * again during a block is the documented way to make the block longer, so the UI
   * puts a warning in front of it.
   */
  async resume(opts?: { force?: boolean }): Promise<void> {
    const s = await this.getState();
    if (!s) return;
    if (s.status !== "paused" && s.status !== "safety_break" && s.status !== "cooldown") return;

    const cooling = await this.d.governor.cooldown();
    if (cooling && !opts?.force) {
      // Still blocked. Refresh what the operator is looking at rather than pretending.
      await this.enterCooldown(s, cooling);
      return;
    }
    if (cooling && opts?.force) await this.d.governor.clearCooldown();

    s.status = "running";
    s.cooldownUntil = undefined;
    s.cooldownReason = undefined;
    s.cooldownClass = undefined;
    s.requiresOperator = undefined;
    s.throttleDeferrals = 0;
    s.errorMessage = undefined;
    s.nextWakeAt = this.d.clock.now();
    await this.persist(s);
    await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
    this.d.logger.info("Run resumed", { runId: s.runId, forced: opts?.force === true });
  }

  async stop(): Promise<void> {
    const s = await this.getState();
    if (!s) return;
    s.status = "done";
    s.finishedAt = this.d.clock.now();
    await this.persist(s);
    await this.d.clock.clearWake(ALARM_TICK);
  }

  /**
   * The alarm handler. Called on every ALARM_TICK. Does one unit of work.
   */
  async tick(): Promise<void> {
    const s = await this.getState();
    if (!s || s.status !== "running") return;
    if (s.locked) {
      this.d.logger.warn("Tick skipped — previous tick still running");
      return;
    }

    const now = this.d.clock.now();

    // Facebook may have told some other part of the app to stop while we were asleep.
    // The budget is shared, so a block earned by a group sync binds the campaign too.
    const cooling = await this.d.governor.cooldown();
    if (cooling) {
      await this.enterCooldown(s, cooling);
      return;
    }

    if (now < s.nextWakeAt) {
      // Woken early; reschedule for the real time.
      await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
      return;
    }

    if (s.cursor >= s.queue.length) {
      await this.finish(s);
      return;
    }

    s.locked = true;
    await this.persist(s);

    const job = s.queue[s.cursor]!;
    let result: PostResult;
    try {
      result = await this.executeJob(s, job);
    } catch (err) {
      result = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    // Facebook refused to consider this post, or the governor never let it out. Either
    // way the composer was not asked, so the job keeps its place in the queue: a post
    // that was never attempted is not a failed post, and recording it as one used to
    // lose that group from the run silently.
    if (result.status === "failed" && (result.deferredUntil != null || this.isBlocked(result))) {
      s.locked = false;
      await this.deferJob(s, job, result, now);
      return;
    }

    // A genuine transient blip gets one more attempt — on a later alarm, not inside
    // this tick.
    //
    // The old path slept a hardcoded eight seconds and re-ran the job in place, which
    // was wrong twice over: eight seconds is a flaky-socket timescale rather than a
    // Facebook one, and an in-tick sleep is exactly what a service worker eviction
    // eats. Rescheduling also means the retry has to earn a slot from the governor
    // like everything else, instead of colliding with the posting spacing and being
    // refused every time.
    const attempts = s.jobAttempts ?? 0;
    if (result.status === "failed" && attempts < 1 && this.isTransientFailure(result)) {
      s.jobAttempts = attempts + 1;
      s.locked = false;
      s.nextWakeAt = now + this.transientBackoffMs();
      await this.persist(s);
      await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
      this.d.logger.info("Transient failure — will try this group again", {
        group: job.groupName,
        error: result.error,
        nextWakeAt: s.nextWakeAt,
      });
      return;
    }

    // Progress: this job is finished with, one way or another.
    if (attempts > 0) result = { ...result, wasRetry: true };
    s.throttleDeferrals = 0;
    s.jobAttempts = 0;
    await this.recordResult(s, job, result);

    // Advance and compute the next wake.
    s.cursor += 1;
    s.locked = false;

    if (result.status === "failed") {
      s.consecutiveFailures += 1;
      const bo = backoffAfterFailure(this.currentAnti(s), s.consecutiveFailures);
      if (bo.autoPause) {
        s.status = "paused";
        s.errorMessage = `Auto-paused after ${s.consecutiveFailures} consecutive failures.`;
        await this.persist(s);
        await this.d.clock.clearWake(ALARM_TICK);
        this.d.logger.error(s.errorMessage);
        return;
      }
      s.nextWakeAt = now + bo.waitMs;
    } else {
      s.consecutiveFailures = 0;
      s.postsSinceBreak += 1;
      const campaign = await this.loadCampaign(s.campaignId);
      if (campaign && shouldSafetyBreak(campaign.safetyBreak, s.postsSinceBreak)) {
        s.status = "safety_break";
        s.nextWakeAt = now + campaign.safetyBreak.durationSeconds * 1000;
        s.postsSinceBreak = 0;
        await this.persist(s);
        await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
        this.d.logger.info("Safety break", { untilMs: s.nextWakeAt });
        // Flip back to running when the break wake fires.
        return;
      }
      const delayMs = campaign
        ? nextDelayMs(campaign.delay, campaign.antiDetection, {
            completedCount: s.results.length,
            totalCount: s.queue.length,
            rand: Math.random,
          })
        : 60_000;
      s.nextWakeAt = now + delayMs;
    }

    if (s.cursor >= s.queue.length) {
      await this.finish(s);
      return;
    }

    await this.persist(s);
    await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
  }

  // ---- internals ----

  private async executeJob(s: RunState, job: PostJob): Promise<PostResult> {
    // Load the campaign FIRST: `currentAnti` reads a cache that only `loadCampaign`
    // fills, so reading it beforehand meant the daily-budget guard silently used the
    // unlimited fallback on the first tick after every service worker restart.
    const campaign = await this.loadCampaign(s.campaignId);

    // Daily budget guard (managed accounts only).
    const account = await this.getAccount(job.accountId);
    const anti = this.currentAnti(s);
    if (account) {
      const usedToday = account.dailyCounts[dayKey(this.d.clock.now())] ?? 0;
      if (dailyBudgetRemaining(anti, usedToday) <= 0) {
        return { status: "failed", error: "Daily post budget reached for this account." };
      }
    }

    const recipe = await this.d.getRecipe();

    // Upload any campaign image within the active session (photo ids are session-scoped,
    // and Facebook consumes them per post, so we upload fresh for each post).
    const work = async (tokens: import("@nashir/shared").SessionTokens, swapped: boolean) => {
      const media = await this.resolveMedia(campaign, tokens, recipe);
      const j = { ...job, ...media };
      return this.postOnce(recipe, tokens, j, s.runId, swapped);
    };

    if (account) {
      // Managed account: swap cookies → scrape fresh tokens → post → restore.
      return this.d.accounts.withAccount(job.accountId, async () =>
        work(await this.d.scraper.scrapeAfterSwap(), true),
      );
    }
    // Current-session run (no managed account / accountId === "current"): no cookie swap.
    return work(await this.d.scraper.scrapeCurrent(), false);
  }

  /**
   * Upload every attachment the campaign carries, in order, within the active session
   * and return the resulting FB media ids.
   *
   * Uploads are sequential on purpose: parallel uploads from one session are exactly
   * the burst signature the rate limiter looks for, and attachment order is the order
   * the post displays them in.
   */
  private async resolveMedia(
    campaign: Campaign | null,
    tokens: import("@nashir/shared").SessionTokens,
    recipe: FbRecipe,
  ): Promise<{ photoIds?: string[]; videoIds?: string[] }> {
    const media = campaign?.media ?? [];
    if (media.length === 0) return {};

    const photoIds: string[] = [];
    const videoIds: string[] = [];
    for (const item of media) {
      const rec = await this.d.media.get(item.blobId);
      if (!rec) {
        this.d.logger.warn("Campaign media blob missing from MediaStore", { blobId: item.blobId });
        continue;
      }
      if (item.kind === "video") {
        videoIds.push(await this.d.videos.upload(rec.blob, rec.name, tokens, recipe));
      } else {
        photoIds.push(await this.d.images.upload(rec.blob, rec.name, tokens, recipe));
      }
    }
    this.d.logger.info("Uploaded campaign media", { photos: photoIds.length, videos: videoIds.length });
    return {
      photoIds: photoIds.length ? photoIds : undefined,
      videoIds: videoIds.length ? videoIds : undefined,
    };
  }

  /** Send one post, with a single silent re-scrape+retry if the token turns out stale. */
  private async postOnce(
    recipe: FbRecipe,
    tokens: import("@nashir/shared").SessionTokens,
    job: PostJob,
    runId: string,
    swapped: boolean,
  ): Promise<PostResult> {
    const send = (t: import("@nashir/shared").SessionTokens) =>
      new FacebookClient(this.d.http, t, recipe, this.d.logger).createGroupPost({
        groupId: job.groupId,
        message: job.message,
        photoIds: job.photoIds,
        videoIds: job.videoIds,
        linkUrl: job.linkUrl,
        scheduledAt: job.scheduledAt,
        composerSessionId: runId,
      });
    let result = await send(tokens);
    if (
      result.status === "failed" &&
      result.error &&
      new FacebookClient(this.d.http, tokens, recipe, this.d.logger).isTokenExpired(result.error)
    ) {
      this.d.logger.info("Token expired — re-scraping and retrying");
      const fresh = swapped ? await this.d.scraper.scrapeAfterSwap() : await this.d.scraper.scrapeCurrent();
      result = await send(fresh);
    }
    return result;
  }

  private async buildQueue(campaign: Campaign): Promise<PostJob[]> {
    const jobs: PostJob[] = [];
    let variationIndex = 0;
    let seq = 0;
    for (const accountId of campaign.accountIds) {
      const groups = await this.d.groups.getGroups(accountId);
      const byId = new Map(groups.map((g) => [g.id, g]));
      for (const groupId of campaign.groupIds) {
        // Use the loaded group's name when available; otherwise fall back to the id
        // (supports manually-entered group ids before the groups loader is wired).
        const group = byId.get(groupId) ?? { id: groupId, name: groupId };
        const message = campaign.variations[variationIndex % campaign.variations.length] ?? "";
        jobs.push({
          id: `job_${seq++}`,
          accountId,
          groupId,
          groupName: group.name,
          variationIndex: variationIndex % campaign.variations.length,
          message,
          // A link preview and an attachment are mutually exclusive in the composer.
          linkUrl: campaign.media?.length ? undefined : campaign.linkUrl,
          scheduledAt: campaign.scheduledAt,
        });
        variationIndex += 1;
      }
    }
    return jobs;
  }

  private async recordResult(s: RunState, job: PostJob, result: PostResult): Promise<void> {
    s.results.push(result);
    s.perAccountCounts[job.accountId] = (s.perAccountCounts[job.accountId] ?? 0) + 1;
    if (result.status !== "failed") {
      const account = await this.getAccount(job.accountId);
      if (account) {
        const key = dayKey(this.d.clock.now());
        account.dailyCounts[key] = (account.dailyCounts[key] ?? 0) + 1;
        account.lastActiveAt = this.d.clock.now();
        await this.saveAccount(account);
      }
    }
    await this.d.analytics.record({
      id: `${s.runId}_${job.id}`,
      ts: this.d.clock.now(),
      accountId: job.accountId,
      campaignId: s.campaignId,
      runId: s.runId,
      groupId: job.groupId,
      groupName: job.groupName,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
      permalink: result.permalink,
    });
    this.d.logger.info(`Posted → ${job.groupName}`, { status: result.status, permalink: result.permalink });
    await this.postFirstComment(s, result);
  }

  /**
   * The campaign's first comment, when it has one and the post actually landed.
   *
   * Best-effort by design: a failed comment must never fail the post, which already
   * succeeded and cannot be un-sent. It is also a separate governed call with its own
   * `mutation.comment` spacing rather than something folded into the post — a comment
   * inside a post's slot would spend two writes where the budget counted one.
   */
  private async postFirstComment(s: RunState, result: PostResult): Promise<void> {
    const comments = this.d.comments;
    if (!comments) return;
    const campaign = await this.d.storage.get<Campaign>(`nashir:campaign:${s.campaignId}`);
    const body = campaign?.firstComment?.trim();
    if (!body) return;
    // Only a published post has somewhere to put it. One pending admin approval is
    // not visible yet, and commenting on it is a call spent on nothing.
    if (result.status !== "published" || !result.permalink) return;

    try {
      const tokens = await this.d.scraper.scrapeFromOpenTab();
      if (!tokens) return;
      const outcome = await comments.comment(
        result.permalink,
        body,
        tokens,
        await this.d.getRecipe(),
      );
      this.d.logger.info("First comment", { permalink: result.permalink, status: outcome.status });
    } catch (err) {
      this.d.logger.warn("First comment failed", {
        permalink: result.permalink,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async finish(s: RunState): Promise<void> {
    s.status = "done";
    s.finishedAt = this.d.clock.now();
    s.locked = false;
    await this.persist(s);
    await this.d.clock.clearWake(ALARM_TICK);
    this.d.logger.info("Run complete", { runId: s.runId, results: s.results.length });
  }

  private currentAnti(s: RunState) {
    // Cached campaign anti-detection cfg is resolved per-tick; fall back to safe defaults.
    return this._antiCache[s.campaignId] ?? {
      jitter: true,
      warmup: true,
      dailyBudgetPerAccount: 0,
      autoPauseAfterConsecutiveFailures: 3,
    };
  }
  private _antiCache: Record<string, Campaign["antiDetection"]> = {};

  private async loadCampaign(id: string): Promise<Campaign | null> {
    const c = await this.d.storage.get<Campaign>(`nashir:campaign:${id}`);
    if (c) this._antiCache[id] = c.antiDetection;
    return c;
  }

  private async getAccount(id: string): Promise<Account | null> {
    const accounts = await this.d.accounts.listAccounts();
    return accounts.find((a) => a.id === id) ?? null;
  }
  private async saveAccount(account: Account): Promise<void> {
    const accounts = await this.d.accounts.listAccounts();
    await this.d.storage.set(
      "nashir:accounts",
      accounts.map((a) => (a.id === account.id ? account : a)),
    );
  }

  /** Did Facebook (or the governor) refuse this, rather than reject its content? */
  private isBlocked(result: PostResult): boolean {
    return result.throttle != null && opensCooldown(result.throttle);
  }

  /**
   * A blip worth one retry.
   *
   * The old test was a regex over the error message that included `/rate/`, which made
   * rate-limit errors the most aggressively retried class in the application — the
   * exact behaviour Meta warns extends a block. Classification is the classifier's job
   * now, and anything that opens a cooldown never reaches here.
   */
  private isTransientFailure(result: PostResult): boolean {
    if (result.deferredUntil != null || this.isBlocked(result)) return false;
    if (result.throttle?.class === "transient") return true;
    return /network|timeout|temporar|failed to fetch|50[0234]/i.test(result.error ?? "");
  }

  /** First rung of the transient ladder, jittered: a few seconds, not a fixed eight. */
  private transientBackoffMs(): number {
    return 4000 + Math.round((this.d.rand ?? Math.random)() * 4000);
  }

  /**
   * Hold the job where it is and stop the run.
   *
   * The queue is untouched — `cursor` does not move and nothing is written to
   * `results` — so resuming picks up exactly the post Facebook would not take.
   */
  private async deferJob(
    s: RunState,
    job: PostJob,
    result: PostResult,
    now: number,
  ): Promise<void> {
    s.throttleDeferrals = (s.throttleDeferrals ?? 0) + 1;

    if (s.throttleDeferrals > MAX_THROTTLE_DEFERRALS) {
      s.status = "paused";
      s.errorMessage = `Facebook is still refusing after ${MAX_THROTTLE_DEFERRALS} attempts. Nothing was lost — resume when it lets us back in.`;
      await this.persist(s);
      await this.d.clock.clearWake(ALARM_TICK);
      this.d.logger.error(s.errorMessage, { group: job.groupName });
      return;
    }

    const cooling = await this.d.governor.cooldown();
    if (cooling) {
      await this.enterCooldown(s, cooling);
      return;
    }

    // Only pacing held it back. Wait out the gap and try the same job again.
    s.nextWakeAt = Math.max(now + 1000, result.deferredUntil ?? now + 30_000);
    await this.persist(s);
    await this.d.clock.scheduleWake(ALARM_TICK, s.nextWakeAt);
    this.d.logger.info("Post held back to stay inside the call budget", {
      group: job.groupName,
      nextWakeAt: s.nextWakeAt,
    });
  }

  /**
   * Park the run because Facebook said stop.
   *
   * No auto-resume alarm is armed. Waiting out a block and then walking straight back
   * into it unattended is how a fifteen-minute throttle becomes a restricted account;
   * the operator gets a countdown and decides.
   */
  private async enterCooldown(
    s: RunState,
    cooling: NonNullable<Awaited<ReturnType<CallGovernor["cooldown"]>>>,
  ): Promise<void> {
    const already = s.status === "cooldown" && s.cooldownUntil === cooling.untilMs;
    s.status = "cooldown";
    s.locked = false;
    s.cooldownUntil = cooling.untilMs;
    s.cooldownClass = cooling.reason;
    s.cooldownReason = cooling.evidence || cooling.matchedSignal;
    s.requiresOperator = cooling.requiresOperator;
    s.nextWakeAt = cooling.untilMs;
    await this.persist(s);
    await this.d.clock.clearWake(ALARM_TICK);
    if (!already) {
      this.d.logger.warn("Run paused — Facebook asked us to stop", {
        runId: s.runId,
        reason: cooling.reason,
        untilMs: cooling.untilMs,
        remaining: s.queue.length - s.cursor,
        evidence: cooling.evidence,
      });
    }
  }

  private async persist(s: RunState): Promise<void> {
    s.updatedAt = this.d.clock.now();
    await this.d.storage.set(RUN_KEY, s);
  }

}
