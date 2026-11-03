import { DEFAULT_FB_RECIPE, type ExtractionState, type PostEvent, type SessionTokens } from "@nashir/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { AudienceService } from "./AudienceService.js";
import {
  ALARM_ENGAGEMENT,
  EngagementService,
  FIRST_CHECK_DELAY_MS,
  POSTS_PER_TICK,
  SECOND_CHECK_DELAY_MS,
} from "./EngagementService.js";
import type { ClockPort, LoggerPort, StoragePort } from "./ports/index.js";

const NOW = 1_700_000_000_000;
const TOKENS = { fb_dtsg: "d" } as unknown as SessionTokens;

const event = (over: Partial<PostEvent>): PostEvent => ({
  id: over.id ?? "e1",
  ts: NOW - FIRST_CHECK_DELAY_MS,
  accountId: "a1",
  campaignId: "c1",
  runId: "r1",
  groupId: "g1",
  groupName: "G",
  status: "published",
  permalink: "https://www.facebook.com/groups/1/posts/2/",
  ...over,
});

function fakes(events: PostEvent[]) {
  const map = new Map<string, unknown>();
  const storage: StoragePort = {
    async get<T>(k: string) {
      return (map.get(k) as T) ?? null;
    },
    async set(k, v) {
      map.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k) {
      map.delete(k);
    },
  };
  const wakes: Array<{ name: string; at: number }> = [];
  const cleared: string[] = [];
  const clock: ClockPort = {
    now: () => NOW,
    async scheduleWake(name, at) {
      wakes.push({ name, at });
    },
    async clearWake(name) {
      cleared.push(name);
    },
  };
  const analytics = { async all() { return events; } } as unknown as AnalyticsStore;
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const extracted: Array<{ url: string; own?: boolean }> = [];
  let nextStatus: ExtractionState["status"] = "done";
  const audience = {
    async extract(url: string, _t: unknown, _r: unknown, opts: { own?: boolean }) {
      extracted.push({ url, ...(opts.own !== undefined ? { own: opts.own } : {}) });
      return { status: nextStatus } as ExtractionState;
    },
  } as unknown as AudienceService;

  const svc = new EngagementService(analytics, audience, storage, clock, logger);
  return {
    svc,
    storage,
    wakes,
    cleared,
    extracted,
    setStatus: (s: ExtractionState["status"]) => {
      nextStatus = s;
    },
  };
}

const getRecipe = async () => DEFAULT_FB_RECIPE;
const getTokens = async () => TOKENS;

describe("configure", () => {
  it("is off until enabled, and arms an alarm when it is", async () => {
    const { svc, wakes, cleared } = fakes([]);
    expect((await svc.getState()).config.enabled).toBe(false);

    await svc.configure({ enabled: true });
    expect(wakes.map((w) => w.name)).toContain(ALARM_ENGAGEMENT);

    await svc.configure({ enabled: false });
    expect(cleared).toContain(ALARM_ENGAGEMENT);
  });
});

describe("due", () => {
  it("selects a published post once it is old enough", async () => {
    const { svc } = fakes([event({})]);
    const out = await svc.due(NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.which).toBe("first");
  });

  it("ignores a post that is still too fresh to mean anything", async () => {
    const { svc } = fakes([event({ ts: NOW - 60_000 })]);
    expect(await svc.due(NOW)).toEqual([]);
  });

  it("ignores anything that is not a landed post", async () => {
    const { svc } = fakes([
      event({ id: "p", status: "pending_approval" }),
      event({ id: "f", status: "failed" }),
      // Published, but we never learned where it went.
      event({ id: "n", permalink: undefined }),
    ]);
    expect(await svc.due(NOW)).toEqual([]);
  });

  it("offers a second read only after the post has settled", async () => {
    const { svc } = fakes([event({})]);
    await svc.configure({ enabled: true });
    await svc.tick(getTokens, getRecipe, NOW);

    // Right after the first check there is nothing to do.
    expect(await svc.due(NOW)).toEqual([]);
    // Three days on, it is worth one more look.
    const later = NOW + SECOND_CHECK_DELAY_MS;
    const due = await svc.due(later);
    expect(due).toHaveLength(1);
    expect(due[0]?.which).toBe("second");
  });

  it("stops after the second read", async () => {
    const { svc } = fakes([event({})]);
    await svc.configure({ enabled: true });
    await svc.tick(getTokens, getRecipe, NOW);
    await svc.tick(getTokens, getRecipe, NOW + SECOND_CHECK_DELAY_MS);
    expect(await svc.due(NOW + SECOND_CHECK_DELAY_MS * 5)).toEqual([]);
  });

  it("returns oldest first", async () => {
    const { svc } = fakes([
      event({ id: "new", ts: NOW - FIRST_CHECK_DELAY_MS, permalink: "https://fb/p/new" }),
      event({ id: "old", ts: NOW - FIRST_CHECK_DELAY_MS * 10, permalink: "https://fb/p/old" }),
    ]);
    const out = await svc.due(NOW);
    expect(out[0]?.event.id).toBe("old");
  });
});

describe("tick", () => {
  let posts: PostEvent[];
  beforeEach(() => {
    posts = Array.from({ length: POSTS_PER_TICK + 2 }, (_, i) =>
      event({ id: `e${i}`, permalink: `https://www.facebook.com/groups/1/posts/${i}/` }),
    );
  });

  it("does nothing while disabled", async () => {
    const { svc, extracted } = fakes(posts);
    expect(await svc.tick(getTokens, getRecipe, NOW)).toMatchObject({ skipped: "disabled" });
    expect(extracted).toEqual([]);
  });

  it("marks sightings as coming from our own post", async () => {
    const { svc, extracted } = fakes([event({})]);
    await svc.configure({ enabled: true });
    await svc.tick(getTokens, getRecipe, NOW);
    expect(extracted[0]?.own).toBe(true);
  });

  it("reads a bounded batch per wake", async () => {
    const { svc, extracted } = fakes(posts);
    await svc.configure({ enabled: true });
    const res = await svc.tick(getTokens, getRecipe, NOW);
    expect(res.checked).toBe(POSTS_PER_TICK);
    expect(extracted).toHaveLength(POSTS_PER_TICK);
  });

  it("waits for a tab rather than opening one", async () => {
    const { svc, extracted } = fakes(posts);
    await svc.configure({ enabled: true });
    const res = await svc.tick(async () => null, getRecipe, NOW);
    expect(res).toMatchObject({ checked: 0, skipped: "no_session" });
    expect(extracted).toEqual([]);
  });

  it("yields to a cooldown and leaves the post unmarked, so it is retried", async () => {
    const { svc, setStatus, extracted } = fakes([event({})]);
    await svc.configure({ enabled: true });
    setStatus("cooldown");
    const res = await svc.tick(getTokens, getRecipe, NOW);
    expect(res.checked).toBe(0);
    expect(extracted).toHaveLength(1);
    // Not marked: the post is still due next hour.
    expect(await svc.due(NOW)).toHaveLength(1);
  });

  it("re-arms its alarm even when there was nothing to do", async () => {
    const { svc, wakes } = fakes([]);
    await svc.configure({ enabled: true });
    const before = wakes.length;
    await svc.tick(getTokens, getRecipe, NOW);
    expect(wakes.length).toBeGreaterThan(before);
  });

  it("stops the batch on an error instead of burning the budget on the rest", async () => {
    // A throw mid-batch means Facebook or the governor pushed back. Continuing to the
    // next post would spend the rest of the budget learning the same thing twice.
    const f = fakes(posts);
    const throwing = new EngagementService(
      { async all() { return posts; } } as unknown as AnalyticsStore,
      {
        async extract() {
          throw new Error("ThrottledError");
        },
      } as unknown as AudienceService,
      f.storage,
      { now: () => NOW, async scheduleWake() {}, async clearWake() {} },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    await throwing.configure({ enabled: true });
    expect((await throwing.tick(getTokens, getRecipe, NOW)).checked).toBe(0);
    // And it stays due, rather than being silently written off.
    expect((await throwing.due(NOW)).length).toBeGreaterThan(0);
  });
});
