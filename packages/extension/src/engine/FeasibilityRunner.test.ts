import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_FB_RECIPE,
  type Account,
  type AccountAuth,
  type AccountHealth,
  type SessionTokens,
  type StepResult,
} from "@nashir/shared";
import { ALARM_RAMP, FeasibilityRunner, type FeasibilityDeps } from "./FeasibilityRunner.js";
import { gatePassed } from "./feasibilityMath.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { SessionProbe } from "./SessionProbe.js";
import type { ClockPort, CookiePort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";
import { CallGovernor } from "./CallGovernor.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

const ACC_A: Account = {
  id: "acc_a",
  fbUserId: "100000000000001",
  label: "Test A",
  addedAt: 0,
  health: "ok",
  dailyCounts: {},
};
const ACC_B: Account = { ...ACC_A, id: "acc_b", fbUserId: "100000000000002", label: "Test B" };

function tokensFor(user: string): SessionTokens {
  return {
    fb_dtsg: "dtsg_test_1234",
    jazoest: "2255",
    lsd: "lsd_test",
    user,
    av: user,
    spinR: "1",
    spinB: "trunk",
    spinT: "1",
    cometReq: "1",
    scrapedAt: 0,
  };
}

const PUBLISHED = JSON.stringify({ data: { story_create: { story: { post_id: "998877" } } } });
const THROTTLED = JSON.stringify({ errors: [{ message: "You're posting too frequently. Slow down." }] });

interface HarnessOptions {
  /** Bodies returned by successive posts; the last one repeats. */
  bodies?: string[];
  fbTabs?: number;
  dnrRules?: number;
  loggedIn?: boolean;
  tokensReady?: boolean;
  accounts?: Account[];
  health?: AccountHealth;
  /** The user id the reloaded page reports — the swap's real proof. */
  scrapedUser?: (activeCUser: string) => string;
}

/**
 * A whole runner wired to in-memory fakes, including a cookie jar that `activate`
 * actually writes to — the swap check's assertions are only meaningful if the jar can
 * disagree with what was asked for.
 */
function harness(opts: HarnessOptions = {}) {
  let clockMs = 1_700_000_000_000;
  const wakes: { name: string; at: number }[] = [];
  const cleared: string[] = [];
  const store = new Map<string, unknown>();
  const jar = new Map<string, string>([["c_user", "999_original"]]);
  const posted: string[] = [];
  let postIndex = 0;

  const storage: StoragePort = {
    get: async <T,>(k: string) => (store.get(k) as T) ?? null,
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
  };

  const clock: ClockPort = {
    now: () => clockMs,
    scheduleWake: async (name, at) => void wakes.push({ name, at }),
    clearWake: async (name) => void cleared.push(name),
  };

  const cookies = {
    get: async (_url: string, name: string) =>
      jar.has(name) ? { name, value: jar.get(name)!, domain: "", path: "/", secure: true, httpOnly: false } : null,
    getAll: async () => [],
    set: async () => {},
    remove: async () => {},
  } as unknown as CookiePort;

  const http: HttpPort = {
    fetch: async () => {
      const bodies = opts.bodies ?? [PUBLISHED];
      const body = bodies[Math.min(postIndex, bodies.length - 1)]!;
      postIndex++;
      posted.push(jar.get("c_user") ?? "");
      return new Response(body, { status: 200 });
    },
  };

  const activate = vi.fn(async (accountId: string) => {
    const account = (opts.accounts ?? [ACC_A, ACC_B]).find((a) => a.id === accountId);
    if (!account) throw new Error(`No stored auth for account ${accountId}`);
    jar.set("c_user", account.fbUserId);
  });
  const restore = vi.fn(async (snap: AccountAuth) => void jar.set("c_user", snap.c_user));

  const accounts = {
    listAccounts: async () => opts.accounts ?? [ACC_A, ACC_B],
    captureCurrent: async (): Promise<AccountAuth> => ({ c_user: jar.get("c_user") ?? "", xs: "xs" }),
    activate,
    restore,
    healthCheck: async () => opts.health ?? "ok",
    withAccount: async <T,>(accountId: string, fn: () => Promise<T>) => {
      const snap = { c_user: jar.get("c_user") ?? "", xs: "xs" };
      await activate(accountId);
      try {
        return await fn();
      } finally {
        await restore(snap);
      }
    },
  } as unknown as CookieAccountManager;

  const scrapeFor = () => {
    const active = jar.get("c_user") ?? "";
    return tokensFor(opts.scrapedUser ? opts.scrapedUser(active) : active);
  };
  const scraper = {
    scrapeCurrent: async () => scrapeFor(),
    scrapeAfterSwap: async () => scrapeFor(),
    scrapeFromOpenTab: async () => scrapeFor(),
  } as unknown as TokenScraper;

  const session = {
    status: async () => ({
      loggedIn: opts.loggedIn ?? true,
      tokensReady: opts.tokensReady ?? true,
      hasOpenTab: true,
      profile: { fbUserId: jar.get("c_user") ?? "" },
    }),
  } as unknown as SessionProbe;

  const governor = new CallGovernor(
    storage,
    clock,
    noopLogger,
    DEFAULT_CALL_BUDGET,
    () => 0.5,
    async (ms) => void (clockMs += ms),
  );

  const deps: FeasibilityDeps = {
    storage,
    clock,
    cookies,
    http,
    logger: noopLogger,
    accounts,
    scraper,
    session,
    governor,
    getRecipe: async () => DEFAULT_FB_RECIPE,
    countFbTabs: async () => opts.fbTabs ?? 1,
    dnrSummary: async () => ({
      ruleCount: opts.dnrRules ?? 4,
      origin: "https://www.facebook.com",
      referer: "https://www.facebook.com/",
    }),
  };

  return {
    governor,
    runner: new FeasibilityRunner(deps),
    jar,
    wakes,
    cleared,
    posted,
    activate,
    restore,
    advance: (ms: number) => (clockMs += ms),
  };
}

const step = (steps: StepResult[], id: string) => steps.find((s) => s.id === id);

describe("post check (1a)", () => {
  it("records the whole sequence and the post's classification", async () => {
    const { runner } = harness();
    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });

    expect(check.verdict).toBe("pass");
    expect(check.steps.map((s) => s.id)).toEqual(["session", "tabs", "dnr", "tokens", "post", "classify"]);
    expect(step(check.steps, "post")!.evidence).toMatchObject({ postStatus: "published", postId: "998877" });
  });

  it("never records the fb_dtsg value, only that one was present", async () => {
    const { runner } = harness();
    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });

    const evidence = JSON.stringify(check.steps.map((s) => s.evidence));
    expect(evidence).not.toContain("dtsg_test_1234");
    expect(step(check.steps, "tokens")!.evidence).toMatchObject({ dtsgLength: 14 });
  });

  it("halts before posting when no DNR rules are installed", async () => {
    const { runner, posted } = harness({ dnrRules: 0 });
    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });

    expect(check.verdict).toBe("fail");
    expect(step(check.steps, "post")).toBeUndefined();
    expect(posted).toHaveLength(0);
  });

  it("halts immediately when nobody is logged in", async () => {
    const { runner } = harness({ loggedIn: false });
    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });

    expect(check.steps.map((s) => s.id)).toEqual(["session"]);
    expect(check.verdict).toBe("fail");
  });

  it("warns rather than fails on a second Facebook tab", async () => {
    const { runner } = harness({ fbTabs: 3 });
    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });

    expect(step(check.steps, "tabs")!.status).toBe("warn");
    // The post still happened, so the check is partial rather than failed.
    expect(check.verdict).toBe("partial");
    expect(step(check.steps, "post")!.status).toBe("pass");
  });

  it("persists the verdict so the report survives a reload", async () => {
    const { runner } = harness();
    await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });
    expect((await runner.get()).checks.post.verdict).toBe("pass");
  });
});

describe("swap check (1b)", () => {
  it("posts as each account and puts the original session back", async () => {
    const h = harness();
    const check = await h.runner.runCheck({
      checkId: "swap",
      groupId: "123",
      message: "hi",
      accountIdA: "acc_a",
      accountIdB: "acc_b",
    });

    expect(check.verdict).toBe("pass");
    // Each post went out under the right c_user — the thing the whole check is for.
    expect(h.posted).toEqual([ACC_A.fbUserId, ACC_B.fbUserId]);
    expect(h.jar.get("c_user")).toBe("999_original");
    expect(step(check.steps, "restore")!.status).toBe("pass");
  });

  it("fails when the reloaded page belongs to someone else, even though the cookie jar agrees", async () => {
    // The subtle failure mode: cookies are written, but Facebook's page still serves the
    // previous session. Checking only c_user would call this a pass.
    const h = harness({ scrapedUser: () => "someone_else" });
    const check = await h.runner.runCheck({
      checkId: "swap",
      groupId: "123",
      message: "hi",
      accountIdA: "acc_a",
      accountIdB: "acc_b",
    });

    expect(step(check.steps, "activateA")!.status).toBe("pass");
    expect(step(check.steps, "tokensA")!.status).toBe("fail");
    expect(check.verdict).toBe("fail");
    expect(h.posted).toHaveLength(0);
    // Still restored, despite bailing out mid-check.
    expect(h.jar.get("c_user")).toBe("999_original");
  });

  it("treats a checkpointed account as detected-and-skipped, not as a post", async () => {
    const h = harness({ health: "checkpoint" });
    const check = await h.runner.runCheck({
      checkId: "swap",
      groupId: "123",
      message: "hi",
      accountIdA: "acc_a",
      accountIdB: "acc_b",
    });

    expect(step(check.steps, "healthA")!.evidence).toMatchObject({ health: "checkpoint", skipped: true });
    expect(step(check.steps, "postA")!.status).toBe("skipped");
    expect(step(check.steps, "postB")!.status).toBe("skipped");
    expect(h.posted).toHaveLength(0);
    expect(check.verdict).toBe("pass");
  });

  it("restores the original session even when a swap throws", async () => {
    const h = harness({ accounts: [ACC_A] }); // acc_b has no stored auth
    const check = await h.runner.runCheck({
      checkId: "swap",
      groupId: "123",
      message: "hi",
      accountIdA: "acc_a",
      accountIdB: "acc_b",
    });

    expect(check.verdict).toBe("fail");
    expect(h.jar.get("c_user")).toBe("999_original");
  });

  it("refuses to start with other Facebook tabs open", async () => {
    const h = harness({ fbTabs: 2 });
    const check = await h.runner.runCheck({
      checkId: "swap",
      groupId: "123",
      message: "hi",
      accountIdA: "acc_a",
      accountIdB: "acc_b",
    });

    expect(check.steps.map((s) => s.id)).toEqual(["preconditions"]);
    expect(check.verdict).toBe("fail");
    expect(h.activate).not.toHaveBeenCalled();
  });
});

describe("rate ramp (1c)", () => {
  const config = {
    accountId: "acc_a",
    groupIds: ["g1", "g2"],
    message: "ramp",
    tiers: [
      { postsPerHour: 12, posts: 2 },
      { postsPerHour: 30, posts: 2 },
    ],
    cap: 10,
  };

  it("sorts tiers ascending — a ramp that does not climb has no ceiling to report", async () => {
    const { runner } = harness();
    const state = await runner.startRamp({
      ...config,
      tiers: [{ postsPerHour: 30, posts: 1 }, { postsPerHour: 12, posts: 1 }],
    });
    expect(state.config.tiers.map((t) => t.postsPerHour)).toEqual([12, 30]);
  });

  it("posts once per tick and paces the next wake to the tier's cadence", async () => {
    const h = harness();
    await h.runner.startRamp(config);
    await h.runner.rampTick();

    expect(h.posted).toHaveLength(1);
    // 12/hour = one post every five minutes.
    const last = h.wakes[h.wakes.length - 1]!;
    expect(last.name).toBe(ALARM_RAMP);
    expect(last.at).toBe(1_700_000_000_000 + 300_000);
  });

  it("records a ceiling only for tiers that completed intact", async () => {
    const h = harness();
    await h.runner.startRamp(config);
    await h.runner.rampTick();
    await h.runner.rampTick();

    const state = (await h.runner.get()).ramp!;
    expect(state.ceilingPostsPerHour).toBe(12);
    expect(state.tierIndex).toBe(1);
  });

  it("stops the moment Facebook throttles and keeps the last intact tier as the ceiling", async () => {
    const h = harness({ bodies: [PUBLISHED, PUBLISHED, THROTTLED] });
    await h.runner.startRamp(config);
    await h.runner.rampTick();
    await h.runner.rampTick();
    await h.runner.rampTick();

    const state = (await h.runner.get()).ramp!;
    expect(state.status).toBe("throttled");
    expect(state.ceilingPostsPerHour).toBe(12);
    expect(state.posts[2]!.throttled).toBe(true);
    expect(h.cleared).toContain(ALARM_RAMP);
  });

  it("fails the check when even the slowest tier is refused", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.runner.startRamp(config);
    await h.runner.rampTick();

    const record = await h.runner.get();
    expect(record.ramp!.ceilingPostsPerHour).toBeUndefined();
    expect(record.checks.ramp.verdict).toBe("fail");
  });

  it("aborts on request and posts nothing further", async () => {
    const h = harness();
    await h.runner.startRamp(config);
    await h.runner.abortRamp();
    await h.runner.rampTick();

    expect(h.posted).toHaveLength(0);
    expect((await h.runner.get()).ramp!.status).toBe("aborted");
  });

  it("honours the hard cap even when the tiers would allow more", async () => {
    const h = harness();
    await h.runner.startRamp({ ...config, tiers: [{ postsPerHour: 60, posts: 10 }], cap: 2 });
    await h.runner.rampTick();
    await h.runner.rampTick();
    await h.runner.rampTick();

    expect(h.posted).toHaveLength(2);
    expect((await h.runner.get()).ramp!.status).toBe("completed");
  });

  it("resumes from persisted state, so an evicted service worker loses nothing", async () => {
    const h = harness();
    await h.runner.startRamp(config);
    await h.runner.rampTick();

    // A fresh runner over the same storage is what the SW gets after eviction.
    const state = (await h.runner.get()).ramp!;
    expect(state.postsDone).toBe(1);
    expect(state.nextWakeAt).toBeGreaterThan(state.startedAt);
  });

  it("will not start a second ramp on top of a running one", async () => {
    const h = harness();
    await h.runner.startRamp(config);
    const again = await h.runner.startRamp({ ...config, cap: 99 });
    expect(again.config.cap).toBe(10);
  });
});

describe("the gate as a whole", () => {
  it("is not passed by one check, however green it is", async () => {
    const { runner } = harness();
    expect(gatePassed(await runner.get())).toBe(false);

    const check = await runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });
    expect(check.verdict).toBe("pass");
    expect(gatePassed(await runner.get())).toBe(false);
  });

  it("clears back to unrun, alarm included", async () => {
    const h = harness();
    await h.runner.runCheck({ checkId: "post", groupId: "123", message: "hi" });
    const cleared = await h.runner.clear();

    expect(cleared.checks.post.verdict).toBe("unrun");
    expect(h.cleared).toContain(ALARM_RAMP);
  });
});

describe("the rate ramp cannot leave the app poisoned", () => {
  it("writes a cooldown when it provokes one, instead of stopping quietly", async () => {
    const h = harness({ bodies: [PUBLISHED, THROTTLED] });
    await h.runner.startRamp({
      accountId: ACC_A.id,
      groupIds: ["111111"],
      message: "hi",
      tiers: [{ postsPerHour: 12, posts: 4 }],
      cap: 10,
    });

    await h.runner.rampTick();
    await h.runner.rampTick();

    const state = (await h.runner.get()).ramp!;
    expect(state.status).toBe("throttled");
    // The ramp used to stop and tell nobody, so the operator's very next campaign ran
    // straight into the block it had just earned.
    const cd = await h.governor.cooldown();
    expect(cd).not.toBeNull();
    expect(cd!.reason).toBe("rate_limit");
  });

  it("refuses to start while Facebook is already limiting us", async () => {
    const h = harness();
    await h.governor.report({
      class: "rate_limit",
      scope: "global",
      evidence: "too many api requests",
      matchedSignal: "code:4",
    });

    await expect(
      h.runner.startRamp({
        accountId: ACC_A.id,
        groupIds: ["111111"],
        message: "hi",
        tiers: [{ postsPerHour: 12, posts: 4 }],
        cap: 10,
      }),
    ).rejects.toThrow(/limiting/i);
  });
});
