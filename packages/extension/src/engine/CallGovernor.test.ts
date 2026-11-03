import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FB_RECIPE } from "@nashir/shared";
import { CallGovernor, GOVERNOR_KEY, ThrottledError } from "./CallGovernor.js";
import { DEFAULT_CALL_BUDGET, detectThrottle } from "./governorMath.js";
import type { ClockPort, LoggerPort, StoragePort } from "./ports/index.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

function fakeClock(start = T0) {
  let t = start;
  const clock: ClockPort = {
    now: () => t,
    scheduleWake: async () => {},
    clearWake: async () => {},
  };
  return { clock, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

function recordingLogger(): LoggerPort & { errors: { msg: string; meta?: object }[] } {
  const errors: { msg: string; meta?: object }[] = [];
  return {
    errors,
    info() {},
    warn() {},
    error(msg, meta) {
      errors.push({ msg, meta });
    },
  };
}

/** A governor whose waits are recorded rather than served. */
function harness(opts: { storage?: StoragePort; rand?: () => number } = {}) {
  const storage = opts.storage ?? memStorage();
  const { clock, advance, set } = fakeClock();
  const logger = recordingLogger();
  const waits: number[] = [];
  const governor = new CallGovernor(
    storage,
    clock,
    logger,
    DEFAULT_CALL_BUDGET,
    opts.rand ?? (() => 0.5),
    async (ms) => {
      waits.push(ms);
      advance(ms);
    },
  );
  return { governor, storage, clock, advance, set, logger, waits };
}

const throttleBody = '{"errors":[{"code":4,"message":"Too many API requests"}]}';
const verdictFor = (body: string, status = 200) =>
  detectThrottle({ status, bodyText: body, recipe: DEFAULT_FB_RECIPE });

describe("CallGovernor.acquire", () => {
  it("lets the first call of a class straight through", async () => {
    const h = harness();
    await expect(h.governor.acquire("www", "read.groups")).resolves.toBeUndefined();
    expect(h.waits).toEqual([]);
  });

  it("waits out the spacing for the next call rather than firing it immediately", async () => {
    const h = harness();
    await h.governor.acquire("www", "read.groups");
    await h.governor.acquire("www", "read.groups");
    expect(h.waits).toEqual([600]);
  });

  it("keeps a long upload chunk loop moving without starving it", async () => {
    const h = harness();
    for (let i = 0; i < 40; i++) await h.governor.acquire("upload", "upload.video");
    // 39 gaps of 250ms: a ten-second tax on a whole video, not a stall.
    expect(h.waits).toHaveLength(39);
    expect(h.waits.every((w) => w === 250)).toBe(true);
  });

  it("does not let a paced read hold up an upload", async () => {
    const h = harness();
    await h.governor.acquire("www", "read.groups");
    await h.governor.acquire("upload", "upload.photo");
    expect(h.waits).toEqual([]);
  });

  it("refuses instead of sleeping when the wait would outlast the service worker", async () => {
    const h = harness();
    await h.governor.acquire("www", "mutation.post");
    // mutation.post spaces at 30s, over the 20s cap on an inline wait.
    await expect(h.governor.acquire("www", "mutation.post")).rejects.toThrow(ThrottledError);
    expect(h.waits).toEqual([]);
  });

  it("serialises mutations even when they are started together", async () => {
    const h = harness();
    const order: string[] = [];
    const one = h.governor.acquire("www", "mutation.leave").then(() => order.push("a"));
    const two = h.governor.acquire("www", "mutation.leave").then(() => order.push("b"));
    await Promise.allSettled([one, two]);
    expect(order[0]).toBe("a");
  });

  it("a refused mutation does not wedge the queue behind it", async () => {
    const h = harness();
    await h.governor.acquire("www", "mutation.post");
    await expect(h.governor.acquire("www", "mutation.post")).rejects.toThrow(ThrottledError);
    h.advance(40_000);
    await expect(h.governor.acquire("www", "mutation.post")).resolves.toBeUndefined();
  });
});

describe("CallGovernor cooldowns", () => {
  it("stops everything once Facebook says stop", async () => {
    const h = harness();
    await h.governor.report(verdictFor(throttleBody));

    await expect(h.governor.acquire("www", "read.groups")).rejects.toThrow(ThrottledError);
    await expect(h.governor.acquire("upload", "upload.video")).rejects.toThrow(ThrottledError);
  });

  it("opens the first rung of the ladder and says when it lifts", async () => {
    const h = harness({ rand: () => 1 });
    await h.governor.report(verdictFor(throttleBody));

    const cd = await h.governor.cooldown();
    expect(cd?.reason).toBe("rate_limit");
    expect(cd?.untilMs).toBe(T0 + 15 * MIN);
    expect(cd?.consecutive).toBe(1);
    expect(cd?.requiresOperator).toBe(false);
  });

  it("climbs the ladder when throttles keep landing", async () => {
    const h = harness({ rand: () => 1 });
    await h.governor.report(verdictFor(throttleBody));
    h.advance(16 * MIN);
    await h.governor.report(verdictFor(throttleBody));

    const cd = await h.governor.cooldown();
    expect(cd?.consecutive).toBe(2);
    expect(cd!.untilMs - cd!.since).toBe(60 * MIN);
  });

  it("reopens on its own once the cooldown has passed", async () => {
    const h = harness({ rand: () => 1 });
    await h.governor.report(verdictFor(throttleBody));
    h.advance(15 * MIN + 1);

    expect(await h.governor.cooldown()).toBeNull();
    await expect(h.governor.acquire("www", "read.groups")).resolves.toBeUndefined();
  });

  it("gives a checkpoint no finish line — no wait clears it, only a person", async () => {
    const h = harness();
    await h.governor.report(verdictFor('{"errors":[{"code":601,"message":"checkpoint"}]}'));
    h.advance(48 * 60 * MIN);

    const cd = await h.governor.cooldown();
    expect(cd?.reason).toBe("checkpoint");
    expect(cd?.requiresOperator).toBe(true);
    const err = await h.governor.acquire("www", "read.groups").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThrottledError);
    expect((err as ThrottledError).requiresOperator).toBe(true);
    expect((err as ThrottledError).retryAtMs).toBeUndefined();
  });

  it("lets Facebook's own stated wait override the ladder", async () => {
    const h = harness({ rand: () => 0 });
    await h.governor.report(
      detectThrottle({
        status: 429,
        headers: { "retry-after": "1800" },
        bodyText: "",
        recipe: DEFAULT_FB_RECIPE,
      }),
    );
    const cd = await h.governor.cooldown();
    expect(cd!.untilMs - cd!.since).toBe(30 * MIN);
  });

  it("logs Facebook's verbatim words so new copy can be recognised next time", async () => {
    const h = harness();
    const body =
      'for (;;);{"error":1357004,"errorSummary":"Too many API requests",' +
      '"errorDescription":"There have been too many calls from this app. Wait a bit and try again."}';
    await h.governor.report(verdictFor(body));

    const entry = h.logger.errors.at(-1);
    expect(entry?.msg).toContain("stop");
    expect(JSON.stringify(entry?.meta)).toContain("too many calls from this app");
  });

  it("never records a request body as evidence — those carry fb_dtsg", async () => {
    const h = harness();
    await h.governor.report(verdictFor(throttleBody));
    const cd = await h.governor.cooldown();
    expect(cd?.evidence).not.toContain("dtsg");
    expect(cd!.evidence.length).toBeLessThanOrEqual(500);
  });

  it("treats a 5xx as a blip, not a block", async () => {
    const h = harness();
    await h.governor.report(verdictFor("", 503));
    expect(await h.governor.cooldown()).toBeNull();
  });

  it("walks the ladder back down after a long clean stretch", async () => {
    const h = harness({ rand: () => 1 });
    await h.governor.report(verdictFor(throttleBody));
    h.advance(16 * MIN);
    await h.governor.report(verdictFor('{"data":{"ok":1}}'));
    h.advance(61 * MIN);
    await h.governor.report(verdictFor('{"data":{"ok":1}}'));

    // The next throttle starts from the bottom rung again.
    await h.governor.report(verdictFor(throttleBody));
    expect((await h.governor.cooldown())?.consecutive).toBe(1);
  });

  it("only the operator can end a block early", async () => {
    const h = harness();
    await h.governor.report(verdictFor(throttleBody));
    await h.governor.clearCooldown();

    expect(await h.governor.cooldown()).toBeNull();
    await expect(h.governor.acquire("www", "read.groups")).resolves.toBeUndefined();
  });
});

describe("CallGovernor survives service worker eviction", () => {
  /**
   * The property the whole design turns on. An in-memory limiter is a limiter that is
   * always empty, because MV3 kills the service worker every ~30 seconds. A second governor
   * over the same storage is that death, in a test.
   */
  it("a cooldown taken by one service worker generation still binds the next", async () => {
    const storage = memStorage();
    const first = harness({ storage });
    await first.governor.report(verdictFor(throttleBody));

    const second = harness({ storage });
    await expect(second.governor.acquire("www", "read.groups")).rejects.toThrow(ThrottledError);
    expect((await second.governor.cooldown())?.reason).toBe("rate_limit");
  });

  it("call counts carry across too, so the hourly budget is real", async () => {
    const storage = memStorage();
    const first = harness({ storage });
    for (let i = 0; i < 5; i++) {
      await first.governor.acquire("www", "read.groups");
    }

    const second = harness({ storage });
    expect((await second.governor.snapshot()).callsLastHour).toBe(5);
  });

  it("starts clean rather than throwing when the stored record is from another version", async () => {
    const storage = memStorage();
    await storage.set(GOVERNOR_KEY, { version: 99, nonsense: true });
    const h = harness({ storage });
    await expect(h.governor.acquire("www", "read.groups")).resolves.toBeUndefined();
  });
});

describe("CallGovernor.snapshot", () => {
  it("reports what has been spent and on what", async () => {
    const h = harness();
    await h.governor.acquire("www", "read.groups", "acct-a");
    h.advance(1000);
    await h.governor.acquire("www", "read.groups", "acct-a");
    h.advance(1000);
    await h.governor.acquire("upload", "upload.photo", "acct-b");

    const snap = await h.governor.snapshot();
    expect(snap.callsLastHour).toBe(3);
    expect(snap.byClass["read.groups"]).toBe(2);
    expect(snap.byClass["upload.photo"]).toBe(1);
    expect(snap.byAccount).toEqual({ "acct-a": 2, "acct-b": 1 });
    expect(snap.cooldown).toBeNull();
  });
});

describe("CallGovernor.check", () => {
  it("answers without spending anything", async () => {
    const h = harness();
    expect((await h.governor.check("www", "read.groups")).allowed).toBe(true);
    expect((await h.governor.check("www", "read.groups")).allowed).toBe(true);
    expect((await h.governor.snapshot()).callsLastHour).toBe(0);
  });
});

describe("CallGovernor.applyBudget", () => {
  it("takes a tightened limit from the recipe", async () => {
    const h = harness();
    h.governor.applyBudget({ perDomain: { www: { perMinute: 1, perHour: 1 } } as never });
    await h.governor.acquire("www", "other");
    await expect(h.governor.acquire("www", "read.groups")).rejects.toThrow(ThrottledError);
  });
});

describe("pressure", () => {
  it("widens pacing once Facebook reports it is near its ceiling, and remembers it", async () => {
    const h = harness();
    await h.governor.report(
      detectThrottle({
        status: 200,
        headers: { "x-app-usage": JSON.stringify({ call_count: 90 }) },
        bodyText: '{"data":{}}',
        recipe: DEFAULT_FB_RECIPE,
      }),
    );
    await h.governor.acquire("www", "read.groups");
    await h.governor.acquire("www", "read.groups");
    // Doubled from 600ms, and applied on a later call than the one that carried it.
    expect(h.waits).toEqual([1200]);
  });
});

describe("ThrottledError", () => {
  it("carries enough for a caller to decide what to do", async () => {
    const h = harness({ rand: () => 1 });
    await h.governor.report(verdictFor(throttleBody));
    const err = (await h.governor
      .acquire("www", "read.groups")
      .catch((e: unknown) => e)) as ThrottledError;

    expect(err.name).toBe("ThrottledError");
    expect(err.reason).toBe("cooldown");
    expect(err.retryAtMs).toBe(T0 + 15 * MIN);
    expect(err.throttleClass).toBe("rate_limit");
    expect(err.requiresOperator).toBe(false);
    expect(err.message).toMatch(/pause/i);
  });
});

describe("no stray timers", () => {
  it("never schedules a real setTimeout for a long wait", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.governor.acquire("www", "mutation.post");
    await expect(h.governor.acquire("www", "mutation.post")).rejects.toThrow(ThrottledError);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("CallGovernor.applyMeasured", () => {
  it("narrows the hourly ceiling to what the ramp actually measured", async () => {
    const h = harness();
    h.governor.applyMeasured({ callBudgetPerHour: 8 });
    expect(h.governor.budget.perDomain.www.perHour).toBe(8);
    // The per-minute cap comes down with it: 8 an hour cannot mean 20 in one minute.
    expect(h.governor.budget.perDomain.www.perMinute).toBe(8);
  });

  it("never widens the shipped default, whatever the measurement said", async () => {
    const h = harness();
    const before = h.governor.budget.perDomain.www.perHour;
    // A generous measurement is evidence we can go no faster, not permission to go
    // faster than the conservative floor we chose to ship.
    h.governor.applyMeasured({ callBudgetPerHour: 5000 });
    expect(h.governor.budget.perDomain.www.perHour).toBe(before);
  });

  it("ignores a ramp that never produced a number", async () => {
    const h = harness();
    const before = h.governor.budget.perDomain.www.perHour;
    h.governor.applyMeasured(null);
    h.governor.applyMeasured(undefined);
    h.governor.applyMeasured({ callBudgetPerHour: 0 });
    expect(h.governor.budget.perDomain.www.perHour).toBe(before);
  });

  it("actually binds — the narrowed budget refuses real calls", async () => {
    const h = harness();
    h.governor.applyMeasured({ callBudgetPerHour: 2 });
    await h.governor.acquire("www", "read.groups");
    h.advance(1000);
    await h.governor.acquire("www", "read.dialog");
    h.advance(1000);
    await expect(h.governor.acquire("www", "other")).rejects.toThrow(ThrottledError);
  });
});
