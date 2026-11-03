import { describe, it, expect, vi } from "vitest";
import {
  CURRENT_SESSION,
  DEFAULT_FB_RECIPE,
  type Campaign,
  type SessionTokens,
} from "@nashir/shared";
import { CampaignEngine, ALARM_TICK } from "./CampaignEngine.js";
import type { CampaignEngineDeps } from "./CampaignEngine.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { GroupService } from "./GroupService.js";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { ImageUploadService } from "./ImageUploadService.js";
import type { VideoUploadService } from "./VideoUploadService.js";
import type { MediaStore } from "./MediaStore.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";
import { CallGovernor } from "./CallGovernor.js";
import { GovernedHttp } from "./GovernedHttp.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const tokens: SessionTokens = {
  fb_dtsg: "dtsg-token",
  jazoest: "2",
  lsd: "l",
  user: "1",
  av: "1",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "1",
  scrapedAt: 0,
};

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

const PUBLISHED = JSON.stringify({ data: { story_create: { story: { post_id: "9001" } } } });
const THROTTLED =
  'for (;;);{"error":1357004,"errorSummary":"Too many API requests",' +
  '"errorDescription":"There have been too many calls from this app. Wait a bit and try again."}';
const SERVER_ERROR = "";

const campaign: Campaign = {
  id: "c1",
  name: "Test",
  accountIds: [CURRENT_SESSION],
  groupIds: ["111111", "222222", "333333"],
  variations: ["hello"],
  media: [],
  delay: { mode: "fixed", minSeconds: 60, maxSeconds: 60 },
  safetyBreak: { enabled: false, everyNPosts: 25, durationSeconds: 300 },
  antiDetection: {
    jitter: false,
    warmup: false,
    dailyBudgetPerAccount: 0,
    autoPauseAfterConsecutiveFailures: 3,
  },
  createdAt: T0,
  updatedAt: T0,
};

/** Engine wired to a real governor over a governed transport — the production path. */
function harness(opts: { bodies?: string[]; statuses?: number[] } = {}) {
  let t = T0;
  const clock: ClockPort = {
    now: () => t,
    scheduleWake: vi.fn(async () => {}),
    clearWake: vi.fn(async () => {}),
  };
  const storage = memStorage();

  let i = 0;
  const inner: HttpPort = {
    fetch: async () => {
      const body = opts.bodies?.[i] ?? opts.bodies?.at(-1) ?? PUBLISHED;
      const status = opts.statuses?.[i] ?? 200;
      i++;
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  };
  const innerSpy = vi.spyOn(inner, "fetch");

  const governor = new CallGovernor(
    storage,
    clock,
    noopLogger,
    DEFAULT_CALL_BUDGET,
    () => 1,
    async (ms) => void (t += ms),
  );
  const http = new GovernedHttp(inner, governor, async () => DEFAULT_FB_RECIPE, noopLogger);

  const deps: CampaignEngineDeps = {
    storage,
    clock,
    logger: noopLogger,
    http,
    accounts: { listAccounts: async () => [] } as unknown as CookieAccountManager,
    scraper: { scrapeCurrent: async () => tokens } as unknown as TokenScraper,
    groups: {
      getGroups: async () => [
        { id: "111111", name: "One" },
        { id: "222222", name: "Two" },
        { id: "333333", name: "Three" },
      ],
    } as unknown as GroupService,
    analytics: { record: async () => {} } as unknown as AnalyticsStore,
    images: { upload: async () => "p1" } as unknown as ImageUploadService,
    videos: { upload: async () => "v1" } as unknown as VideoUploadService,
    media: { get: async () => null } as unknown as MediaStore,
    getRecipe: async () => DEFAULT_FB_RECIPE,
    governor,
    rand: () => 0.5,
  };

  const engine = new CampaignEngine(deps);
  return {
    engine,
    governor,
    storage,
    clock,
    innerSpy,
    advance: (ms: number) => void (t += ms),
    async begin() {
      await storage.set("nashir:campaign:c1", campaign);
      await engine.start(campaign);
    },
  };
}

describe("a throttled post is not a failed post", () => {
  it("leaves the job in the queue instead of burning it", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();

    await h.engine.tick();

    const s = (await h.engine.getState())!;
    // The composer was refused, so the group has not had its turn. Advancing the
    // cursor here used to drop it from the run without telling anyone.
    expect(s.cursor).toBe(0);
    expect(s.results).toHaveLength(0);
    expect(s.status).toBe("cooldown");
  });

  it("never retries into a live block", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();

    await h.engine.tick();

    // Exactly one composer POST. The old path slept eight seconds and re-ran the whole
    // job — the precise behaviour Meta warns extends a block.
    expect(h.innerSpy).toHaveBeenCalledTimes(1);
  });

  it("stops the tick alarm rather than arming an unattended resume", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();

    await h.engine.tick();

    expect(h.clock.clearWake).toHaveBeenCalledWith(ALARM_TICK);
    const scheduled = (h.clock.scheduleWake as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === ALARM_TICK,
    );
    // Only the one `start()` armed. Nothing re-arms a run Facebook has blocked.
    expect(scheduled).toHaveLength(1);
  });

  it("records what Facebook said, in Facebook's own words", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();

    await h.engine.tick();

    const s = (await h.engine.getState())!;
    expect(s.cooldownClass).toBe("rate_limit");
    expect(s.cooldownReason).toContain("too many calls from this app");
    expect(s.cooldownUntil).toBeGreaterThan(T0);
    expect(s.requiresOperator).toBe(false);
  });

  it("holds a later tick without touching the network", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();
    await h.engine.tick();
    expect(h.innerSpy).toHaveBeenCalledTimes(1);

    h.advance(5 * MIN);
    await h.engine.tick();

    expect(h.innerSpy).toHaveBeenCalledTimes(1);
    expect((await h.engine.getState())!.cursor).toBe(0);
  });
});

describe("resuming after a cooldown is the operator's call", () => {
  it("refuses to resume while the block is still live", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();
    await h.engine.tick();

    await h.engine.resume();

    expect((await h.engine.getState())!.status).toBe("cooldown");
    expect(h.innerSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes the very job Facebook refused, once the operator says so", async () => {
    const h = harness({ bodies: [THROTTLED, PUBLISHED] });
    await h.begin();
    await h.engine.tick();

    h.advance(16 * MIN);
    await h.engine.resume();
    expect((await h.engine.getState())!.status).toBe("running");

    await h.engine.tick();

    const s = (await h.engine.getState())!;
    expect(s.cursor).toBe(1);
    expect(s.results).toHaveLength(1);
    expect(s.results[0]!.status).toBe("published");
    // The same group, not the next one — nothing was skipped.
    expect(s.queue[0]!.groupId).toBe("111111");
  });

  it("lets the operator override a live block deliberately", async () => {
    const h = harness({ bodies: [THROTTLED, PUBLISHED] });
    await h.begin();
    await h.engine.tick();

    await h.engine.resume({ force: true });

    const s = (await h.engine.getState())!;
    expect(s.status).toBe("running");
    expect(s.cooldownUntil).toBeUndefined();
    expect(await h.governor.cooldown()).toBeNull();
  });

  it("gives up and waits for a person when the budget will not free up", async () => {
    const h = harness();
    await h.begin();
    // A budget with nothing left in it: every attempt is held back, none of them is a
    // Facebook block. Deferring forever would look identical to a hung run.
    h.governor.applyBudget({
      perDomain: { www: { perMinute: 0, perHour: 0 }, upload: { perMinute: 60, perHour: 600 } },
      maxSyncWaitMs: 0,
    });

    for (let n = 0; n < 6; n++) {
      h.advance(61_000);
      await h.engine.tick();
    }

    const s = (await h.engine.getState())!;
    expect(s.status).toBe("paused");
    expect(s.errorMessage).toMatch(/still refusing/i);
    // Nothing was lost: the queue is exactly where it started.
    expect(s.cursor).toBe(0);
    expect(s.results).toHaveLength(0);
    expect(h.innerSpy).not.toHaveBeenCalled();
  });

  it("keeps the job and waits when only pacing held it back", async () => {
    const h = harness();
    await h.begin();
    h.governor.applyBudget({
      perDomain: { www: { perMinute: 0, perHour: 0 }, upload: { perMinute: 60, perHour: 600 } },
      maxSyncWaitMs: 0,
    });

    await h.engine.tick();

    const s = (await h.engine.getState())!;
    // A pacing hold is not a block: the run stays running and simply waits.
    expect(s.status).toBe("running");
    expect(s.cursor).toBe(0);
    expect(s.throttleDeferrals).toBe(1);
    expect(s.nextWakeAt).toBeGreaterThan(T0);
  });
});

describe("the run reacts to a block earned elsewhere", () => {
  it("stands down when a group sync got the app throttled", async () => {
    const h = harness();
    await h.begin();
    // A cooldown opened by some other subsystem — the budget is the app's, not the run's.
    await h.governor.report({
      class: "rate_limit",
      scope: "global",
      evidence: "too many api requests",
      matchedSignal: "code:4",
    });

    await h.engine.tick();

    expect((await h.engine.getState())!.status).toBe("cooldown");
    expect(h.innerSpy).not.toHaveBeenCalled();
  });
});

describe("ordinary failures still behave", () => {
  it("retries a 5xx on a later alarm rather than sleeping inside the tick", async () => {
    const h = harness({ bodies: [SERVER_ERROR, PUBLISHED], statuses: [503, 200] });
    await h.begin();

    await h.engine.tick();

    let s = (await h.engine.getState())!;
    // Held, not failed: the group keeps its place and the run keeps running.
    expect(s.status).toBe("running");
    expect(s.cursor).toBe(0);
    expect(s.results).toHaveLength(0);
    expect(s.jobAttempts).toBe(1);
    // Seconds, not the minutes a throttle would earn.
    expect(s.nextWakeAt - T0).toBeGreaterThanOrEqual(4000);
    expect(s.nextWakeAt - T0).toBeLessThanOrEqual(8000);

    h.advance(60_000);
    await h.engine.tick();

    s = (await h.engine.getState())!;
    expect(h.innerSpy).toHaveBeenCalledTimes(2);
    expect(s.cursor).toBe(1);
    expect(s.results[0]!.status).toBe("published");
    expect(s.results[0]!.wasRetry).toBe(true);
    expect(s.jobAttempts).toBe(0);
  });

  it("gives up on a group that keeps failing instead of stalling the whole run", async () => {
    const h = harness({ bodies: [SERVER_ERROR], statuses: [503] });
    await h.begin();

    await h.engine.tick();
    h.advance(60_000);
    await h.engine.tick();

    const s = (await h.engine.getState())!;
    // One retry, then it is recorded as failed and the run moves on to the next group.
    expect(s.cursor).toBe(1);
    expect(s.results).toHaveLength(1);
    expect(s.results[0]!.status).toBe("failed");
    expect(s.status).toBe("running");
  });

  it("still publishes a clean run end to end", async () => {
    const h = harness({ bodies: [PUBLISHED] });
    await h.begin();

    for (let n = 0; n < 3; n++) {
      const s = (await h.engine.getState())!;
      h.advance(Math.max(0, s.nextWakeAt - T0) + 61_000);
      await h.engine.tick();
    }

    const s = (await h.engine.getState())!;
    expect(s.results).toHaveLength(3);
    expect(s.results.every((r) => r.status === "published")).toBe(true);
  });
});

describe("a checkpoint is not something a timer fixes", () => {
  it("marks the run as needing a person and never lifts on its own", async () => {
    const h = harness({
      bodies: ['{"errors":[{"code":601,"message":"Please confirm your identity"}]}'],
    });
    await h.begin();

    await h.engine.tick();
    h.advance(48 * 60 * MIN);
    await h.engine.resume();

    const s = (await h.engine.getState())!;
    expect(s.status).toBe("cooldown");
    expect(s.cooldownClass).toBe("checkpoint");
    expect(s.requiresOperator).toBe(true);
  });
});

describe("the snapshot carries what the dashboard needs", () => {
  it("surfaces the cooldown, and the auto-pause reason that used to be invisible", async () => {
    const h = harness({ bodies: [THROTTLED] });
    await h.begin();
    await h.engine.tick();

    const snap = (await h.engine.getSnapshot())!;
    expect(snap.status).toBe("cooldown");
    expect(snap.cooldownClass).toBe("rate_limit");
    expect(snap.cooldownReason).toContain("too many calls");
    expect(snap.cooldownUntil).toBeGreaterThan(T0);
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(0);
  });
});
