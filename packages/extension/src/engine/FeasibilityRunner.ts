import type {
  CheckId,
  CheckRecord,
  FbRecipe,
  FeasibilityRecord,
  RampConfig,
  RampState,
  StepResult,
  StepStatus,
} from "@nashir/shared";
import type { ClockPort, CookiePort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { SessionProbe } from "./SessionProbe.js";
import { FacebookClient } from "./FacebookClient.js";
import { emptyRecord, isRateLimited, verdictFor } from "./feasibilityMath.js";
import type { CallGovernor } from "./CallGovernor.js";
import { detectThrottle } from "./governorMath.js";

/**
 * FeasibilityRunner — the Phase-1 go/no-go gate, run by a human, recorded by the engine.
 *
 * Everything above this layer (campaigns, safety timing, analytics) is built on three
 * assumptions that only a real Facebook account can confirm: a post actually lands, a
 * cookie swap round-trips without corrupting the operator's own session, and there is a
 * cadence Facebook tolerates. This module sequences those checks and writes down what
 * happened, so "we tested it" is a record rather than a memory.
 *
 * It deliberately does NOT start itself. Every entry point here is a response to an
 * explicit operator action, because each one posts to a real group as a real account.
 *
 * Ports only, no chrome.* — the two capabilities that genuinely need Chrome (counting
 * Facebook tabs, reading the installed DNR rules) are injected as functions.
 */

const RECORD_KEY = "nashir:feasibility:v1";

/** Alarm the rate ramp wakes on. Its own name, so it never collides with the campaign tick. */
export const ALARM_RAMP = "nashir:ramp-tick";

const FB_URL = "https://www.facebook.com";

export interface DnrSummary {
  ruleCount: number;
  origin?: string;
  referer?: string;
}

export interface FeasibilityDeps {
  storage: StoragePort;
  clock: ClockPort;
  cookies: CookiePort;
  http: HttpPort;
  logger: LoggerPort;
  accounts: CookieAccountManager;
  scraper: TokenScraper;
  session: SessionProbe;
  getRecipe: () => Promise<FbRecipe>;
  /** How many facebook.com tabs are open right now (chrome.tabs lives in platform). */
  countFbTabs: () => Promise<number>;
  /** What the installed declarativeNetRequest header rules say. */
  dnrSummary: () => Promise<DnrSummary>;
  /**
   * The call governor. The ramp deliberately provokes a throttle, so it is the one
   * subsystem that must both refuse to start inside a live block and report the block
   * it earns — otherwise the operator's next campaign walks straight into it.
   */
  governor?: CallGovernor;
}

export interface RunCheckInput {
  checkId: Exclude<CheckId, "ramp">;
  groupId: string;
  message: string;
  accountIdA?: string;
  accountIdB?: string;
}

/** What one step's body returns; the runner supplies id, timing and error handling. */
type StepOutcome = {
  status?: StepStatus;
  detail?: string;
  evidence?: Record<string, string | number | boolean>;
};

export class FeasibilityRunner {
  constructor(private readonly deps: FeasibilityDeps) {}

  async get(): Promise<FeasibilityRecord> {
    const stored = await this.deps.storage.get<FeasibilityRecord>(RECORD_KEY);
    return stored ?? emptyRecord(this.now());
  }

  async clear(): Promise<FeasibilityRecord> {
    await this.deps.clock.clearWake(ALARM_RAMP);
    const fresh = emptyRecord(this.now());
    await this.deps.storage.set(RECORD_KEY, fresh);
    return fresh;
  }

  async runCheck(input: RunCheckInput): Promise<CheckRecord> {
    return input.checkId === "post" ? this.runPostCheck(input) : this.runSwapCheck(input);
  }

  // ---- 1a: does a post actually land? ----

  /**
   * The narrow question: with this browser's own live session, does the composer
   * mutation produce a real post, and can we tell published from pending-approval?
   *
   * The Origin/Referer rewrite cannot be observed directly — DNR edits the request after
   * fetch() hands it over, and `getMatchedRules` needs a permission we deliberately don't
   * ship. So we record what the installed rules say, and treat Facebook accepting the
   * POST as the proof: without the rewrite it rejects the request outright.
   */
  private async runPostCheck(input: RunCheckInput): Promise<CheckRecord> {
    const steps: StepResult[] = [];
    const startedAt = this.now();

    const session = await this.step(steps, "session", async () => {
      const st = await this.deps.session.status(true);
      if (!st.loggedIn) return { status: "fail", detail: "No logged-in Facebook session in this browser." };
      if (!st.tokensReady) {
        return { status: "fail", detail: "Cookie says logged in, but a live page yielded no tokens." };
      }
      return {
        status: "pass",
        evidence: { fbUserId: st.profile?.fbUserId ?? "", name: st.profile?.name ?? "" },
      };
    });
    if (session.status === "fail") return this.finish("post", steps, startedAt);

    await this.step(steps, "tabs", async () => {
      const count = await this.deps.countFbTabs();
      // Advisory here: a second tab cannot change which account this browser is logged
      // in as, it only matters once we start swapping cookies underneath one.
      return count > 1
        ? { status: "warn", detail: `${count} facebook.com tabs open.`, evidence: { count } }
        : { status: "pass", evidence: { count } };
    });

    const dnr = await this.step(steps, "dnr", async () => {
      const summary = await this.deps.dnrSummary();
      if (summary.ruleCount === 0) {
        return { status: "fail", detail: "No declarativeNetRequest rules installed — every POST will be rejected." };
      }
      return {
        status: "pass",
        evidence: {
          rules: summary.ruleCount,
          origin: summary.origin ?? "",
          referer: summary.referer ?? "",
        },
      };
    });
    if (dnr.status === "fail") return this.finish("post", steps, startedAt);

    const recipe = await this.deps.getRecipe();
    const tokens = await this.step(steps, "tokens", async () => {
      const t = await this.deps.scraper.scrapeCurrent();
      // Length, never the value: fb_dtsg is a live CSRF token.
      return {
        status: "pass",
        evidence: { user: t.user, dtsgLength: t.fb_dtsg.length, hasLsd: Boolean(t.lsd) },
      };
    });
    if (tokens.status === "fail") return this.finish("post", steps, startedAt);

    // The explicit return type matters: without it TypeScript unions the two literal
    // shapes and synthesises `postStatus?: undefined`, which the evidence index signature
    // then rejects.
    const posted = await this.step(steps, "post", async (): Promise<StepOutcome> => {
      const t = await this.deps.scraper.scrapeCurrent();
      const fb = new FacebookClient(this.deps.http, t, recipe, this.deps.logger);
      const result = await fb.createGroupPost({
        groupId: input.groupId,
        message: input.message,
        composerSessionId: `feasibility_${this.now()}`,
      });
      if (result.status === "failed") {
        return {
          status: "fail",
          detail: result.error ?? "Post failed with no error text.",
          evidence: { docId: recipe.createGroupPost.docId, latencyMs: result.latencyMs ?? 0 },
        };
      }
      return {
        status: "pass",
        evidence: {
          postStatus: result.status,
          postId: result.postId ?? "",
          permalink: result.permalink ?? "",
          latencyMs: result.latencyMs ?? 0,
          docId: recipe.createGroupPost.docId,
        },
      };
    });
    if (posted.status === "fail") return this.finish("post", steps, startedAt);

    // Worth calling out specifically: a 200 from Facebook often means "queued for
    // an admin", not "live". Whether we read that correctly is itself part of the gate.
    await this.step(steps, "classify", async () => {
      const postStatus = String(posted.evidence?.["postStatus"] ?? "");
      if (postStatus === "submitted") {
        return {
          status: "warn",
          detail: "Facebook accepted the post but returned no id — we cannot tell published from pending.",
          evidence: { postStatus },
        };
      }
      return { status: "pass", evidence: { postStatus } };
    });

    return this.finish("post", steps, startedAt);
  }

  // ---- 1b: does a cookie swap round-trip? ----

  /**
   * Risk #2, end to end. The load-bearing assertion is not that the cookie jar changed —
   * that is trivially true — but that a freshly loaded Facebook page then hands back
   * tokens belonging to the swapped-in account, and that the operator's own session is
   * byte-identical afterwards.
   */
  private async runSwapCheck(input: RunCheckInput): Promise<CheckRecord> {
    const steps: StepResult[] = [];
    const startedAt = this.now();

    const accounts = await this.deps.accounts.listAccounts();
    const a = accounts.find((x) => x.id === input.accountIdA);
    const b = accounts.find((x) => x.id === input.accountIdB);

    const pre = await this.step(steps, "preconditions", async (): Promise<StepOutcome> => {
      if (!a || !b) return { status: "fail", detail: "Two managed accounts are required." };
      if (a.id === b.id) return { status: "fail", detail: "Pick two different accounts." };
      const count = await this.deps.countFbTabs();
      if (count > 1) {
        return {
          status: "fail",
          detail: `${count} facebook.com tabs are open. A tab can re-write the session cookie mid-swap; close all but one.`,
          evidence: { count },
        };
      }
      return { status: "pass", evidence: { count, accountA: a.label, accountB: b.label } };
    });
    if (pre.status === "fail" || !a || !b) return this.finish("swap", steps, startedAt);

    const snapshot = await this.deps.accounts.captureCurrent();
    await this.step(steps, "snapshot", async () => ({
      status: "pass",
      evidence: { hadSession: Boolean(snapshot.c_user), fbUserId: snapshot.c_user },
    }));

    try {
      for (const account of [a, b]) {
        const suffix = account.id === a.id ? "A" : "B";
        const swapped = await this.step(steps, `activate${suffix}`, async () => {
          await this.deps.accounts.activate(account.id);
          const cUser = await this.deps.cookies.get(FB_URL, "c_user");
          if (cUser?.value !== account.fbUserId) {
            return { status: "fail", detail: `c_user is ${cUser?.value ?? "(none)"}, expected ${account.fbUserId}.` };
          }
          return { status: "pass", evidence: { fbUserId: account.fbUserId, label: account.label } };
        });
        if (swapped.status === "fail") break;

        const health = await this.step(steps, `health${suffix}`, async () => {
          const classified = await this.deps.accounts.healthCheck();
          // The negative case: an account Facebook has logged out or checkpointed
          // must be DETECTED and skipped. Detecting it is the pass, not a failure.
          if (classified !== "ok") {
            return {
              status: "pass",
              detail: `Classified as ${classified} — posting skipped, which is the correct behaviour.`,
              evidence: { health: classified, skipped: true },
            };
          }
          return { status: "pass", evidence: { health: classified, skipped: false } };
        });
        const skipped = health.evidence?.["skipped"] === true;

        if (skipped) {
          steps.push({ id: `tokens${suffix}`, status: "skipped", at: this.now() });
          steps.push({ id: `post${suffix}`, status: "skipped", at: this.now() });
          continue;
        }

        const tokens = await this.step(steps, `tokens${suffix}`, async () => {
          const t = await this.deps.scraper.scrapeAfterSwap();
          if (t.user !== account.fbUserId) {
            return {
              status: "fail",
              detail: `The reloaded page belongs to ${t.user}, not ${account.fbUserId}. The swap did not take at page level.`,
            };
          }
          return { status: "pass", evidence: { user: t.user, dtsgLength: t.fb_dtsg.length } };
        });
        if (tokens.status === "fail") break;

        await this.step(steps, `post${suffix}`, async () => {
          const recipe = await this.deps.getRecipe();
          const t = await this.deps.scraper.scrapeCurrent();
          const fb = new FacebookClient(this.deps.http, t, recipe, this.deps.logger);
          const result = await fb.createGroupPost({
            groupId: input.groupId,
            message: `${input.message} — ${account.label}`,
            composerSessionId: `feasibility_swap_${this.now()}`,
          });
          if (result.status === "failed") {
            return { status: "fail", detail: result.error ?? "Post failed with no error text." };
          }
          return {
            status: "pass",
            evidence: {
              postStatus: result.status,
              permalink: result.permalink ?? "",
              author: account.label,
              latencyMs: result.latencyMs ?? 0,
            },
          };
        });
      }
    } finally {
      // Non-negotiable: whatever went wrong above, the operator gets their own session
      // back. This runs even on a thrown error, and its own failure is recorded too.
      await this.step(steps, "restore", async () => {
        await this.deps.accounts.restore(snapshot);
        const cUser = await this.deps.cookies.get(FB_URL, "c_user");
        const back = (cUser?.value ?? "") === snapshot.c_user;
        if (!back) {
          return {
            status: "fail",
            detail: `Session NOT restored: c_user is ${cUser?.value ?? "(none)"}, expected ${snapshot.c_user || "(none)"}.`,
          };
        }
        return { status: "pass", evidence: { fbUserId: snapshot.c_user } };
      });
    }

    return this.finish("swap", steps, startedAt);
  }

  // ---- 1c: what cadence does Facebook tolerate? ----

  /**
   * Tiers are sorted ascending: a ramp that does not climb has no ceiling to report, and
   * the whole point is to find the last rung that held.
   */
  async startRamp(config: RampConfig): Promise<RampState> {
    const record = await this.get();
    if (record.ramp?.status === "running") return record.ramp;

    // Starting a deliberate rate probe while Facebook is already blocking us would
    // measure the block, not the ceiling — and would deepen it.
    const cooling = await this.deps.governor?.cooldown();
    if (cooling) {
      throw new Error(
        "Facebook is currently limiting this app. The rate ramp cannot run until that clears.",
      );
    }

    const now = this.now();
    const state: RampState = {
      config: { ...config, tiers: [...config.tiers].sort((x, y) => x.postsPerHour - y.postsPerHour) },
      status: "running",
      tierIndex: 0,
      postsInTier: 0,
      postsDone: 0,
      startedAt: now,
      nextWakeAt: now,
      posts: [],
    };
    await this.save({ ...record, ramp: state });
    // A second from now, not immediately: the operator's click should return before the
    // first real post goes out, so an accidental start is still abortable.
    await this.deps.clock.scheduleWake(ALARM_RAMP, now + 1000);
    this.deps.logger.info("Rate ramp started", { tiers: state.config.tiers.length, cap: config.cap });
    return state;
  }

  async abortRamp(): Promise<RampState | null> {
    const record = await this.get();
    if (!record.ramp || record.ramp.status !== "running") return record.ramp ?? null;
    await this.deps.clock.clearWake(ALARM_RAMP);
    return this.finishRamp(record, record.ramp, "aborted");
  }

  /** One alarm wake = exactly one post, so an evicted service worker loses nothing. */
  async rampTick(): Promise<RampState | null> {
    const record = await this.get();
    const ramp = record.ramp;
    if (!ramp || ramp.status !== "running") return ramp ?? null;

    const tier = ramp.config.tiers[ramp.tierIndex];
    if (!tier || ramp.postsDone >= ramp.config.cap) {
      return this.finishRamp(record, ramp, "completed");
    }

    const groupId = ramp.config.groupIds[ramp.postsDone % ramp.config.groupIds.length]!;
    const recipe = await this.deps.getRecipe();
    const result = await this.postAs(ramp.config.accountId, groupId, ramp.config.message, recipe);
    const throttled = result.status === "failed" && isRateLimited(result.error ?? "", recipe);

    ramp.posts.push({
      at: this.now(),
      tierPostsPerHour: tier.postsPerHour,
      groupId,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      throttled,
    });
    ramp.postsDone++;
    ramp.postsInTier++;

    if (throttled) {
      this.deps.logger.warn("Rate ramp hit a throttle", {
        postsPerHour: tier.postsPerHour,
        postsDone: ramp.postsDone,
      });
      // Tell the governor. The ramp used to stop and tell nobody, so the operator's
      // very next campaign ran straight into the block the ramp had just earned.
      await this.deps.governor?.report(
        detectThrottle({ bodyText: result.error ?? "", recipe }, this.now()),
        ramp.config.accountId,
      );
      return this.finishRamp(record, ramp, "throttled");
    }

    if (ramp.postsInTier >= tier.posts) {
      // A tier survived intact — this is the number the whole check exists to produce.
      ramp.ceilingPostsPerHour = tier.postsPerHour;
      ramp.tierIndex++;
      ramp.postsInTier = 0;
      if (ramp.tierIndex >= ramp.config.tiers.length) {
        return this.finishRamp(record, ramp, "completed");
      }
    }

    const nextTier = ramp.config.tiers[ramp.tierIndex] ?? tier;
    ramp.nextWakeAt = this.now() + Math.round(3_600_000 / nextTier.postsPerHour);
    await this.save({ ...record, ramp });
    await this.deps.clock.scheduleWake(ALARM_RAMP, ramp.nextWakeAt);
    return ramp;
  }

  // ---- internals ----

  /**
   * A ramp post is a real post, so it goes through the same snapshot → swap → restore
   * path a campaign uses. It is deliberately NOT written to AnalyticsStore: these are
   * diagnostics, and mixing them into the operator's real numbers would distort them.
   */
  private async postAs(accountId: string, groupId: string, message: string, recipe: FbRecipe) {
    try {
      return await this.deps.accounts.withAccount(accountId, async () => {
        const tokens = await this.deps.scraper.scrapeAfterSwap();
        const fb = new FacebookClient(this.deps.http, tokens, recipe, this.deps.logger);
        return fb.createGroupPost({
          groupId,
          message,
          composerSessionId: `feasibility_ramp_${this.now()}`,
        });
      });
    } catch (err) {
      return {
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async finishRamp(
    record: FeasibilityRecord,
    ramp: RampState,
    status: RampState["status"],
  ): Promise<RampState> {
    ramp.status = status;
    ramp.finishedAt = this.now();
    ramp.nextWakeAt = undefined;
    await this.deps.clock.clearWake(ALARM_RAMP);

    // The ramp check's verdict mirrors what the ladder found: a ceiling is a result even
    // when the run ended on a throttle — that IS the answer. Only "no rung held" fails.
    const steps: StepResult[] = [
      {
        id: "ramp",
        status: ramp.ceilingPostsPerHour ? "pass" : "fail",
        at: ramp.finishedAt,
        detail:
          ramp.ceilingPostsPerHour == null
            ? "No tier completed without a throttle — even the slowest cadence was refused."
            : undefined,
        evidence: {
          outcome: status,
          postsDone: ramp.postsDone,
          ceilingPostsPerHour: ramp.ceilingPostsPerHour ?? 0,
          throttled: ramp.posts.some((p) => p.throttled),
        },
      },
    ];

    await this.save({
      ...record,
      ramp,
      checks: {
        ...record.checks,
        ramp: {
          id: "ramp",
          verdict: ramp.ceilingPostsPerHour ? "pass" : "fail",
          steps,
          startedAt: ramp.startedAt,
          finishedAt: ramp.finishedAt,
        },
      },
    });
    return ramp;
  }

  /**
   * Run one step, recording timing and turning a thrown error into a `fail` rather than
   * losing the whole check. Steps are appended as they finish, so a check that dies
   * halfway still shows the operator exactly how far it got.
   */
  private async step(
    steps: StepResult[],
    id: string,
    fn: () => Promise<StepOutcome>,
  ): Promise<StepResult> {
    const startedAt = this.now();
    let result: StepResult;
    try {
      const outcome = await fn();
      result = {
        id,
        status: outcome.status ?? "pass",
        detail: outcome.detail,
        evidence: outcome.evidence,
        at: this.now(),
        latencyMs: this.now() - startedAt,
      };
    } catch (err) {
      result = {
        id,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        at: this.now(),
        latencyMs: this.now() - startedAt,
      };
    }
    steps.push(result);
    return result;
  }

  private async finish(id: CheckId, steps: StepResult[], startedAt: number): Promise<CheckRecord> {
    const check: CheckRecord = {
      id,
      verdict: verdictFor(steps),
      steps,
      startedAt,
      finishedAt: this.now(),
    };
    const record = await this.get();
    await this.save({ ...record, checks: { ...record.checks, [id]: check } });
    this.deps.logger.info("Feasibility check finished", { id, verdict: check.verdict });
    return check;
  }

  private async save(record: FeasibilityRecord): Promise<void> {
    await this.deps.storage.set(RECORD_KEY, { ...record, updatedAt: this.now() });
  }

  private now(): number {
    return this.deps.clock.now();
  }
}
