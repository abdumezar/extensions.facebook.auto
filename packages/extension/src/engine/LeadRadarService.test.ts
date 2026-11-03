import { DEFAULT_FB_RECIPE, type FbRecipe, type Group, type SessionTokens } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import type { AudienceStore } from "./AudienceStore.js";
import {
  ALARM_RADAR,
  GROUPS_PER_TICK,
  LeadRadarService,
  MAX_MATCHES,
  type RadarPorts,
  parseFeed,
} from "./LeadRadarService.js";
import type { LeadRule } from "./leadScore.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const NOW = 1_700_000_000_000;
const TOKENS = { av: "1", user: "1", cometReq: "15", fb_dtsg: "d", jazoest: "2", lsd: "l" } as SessionTokens;

/** The recipe with a groupFeed doc_id, as it will look once one is captured. */
const RECIPE: FbRecipe = {
  ...DEFAULT_FB_RECIPE,
  groupFeed: { docId: "123", friendlyName: "GroupsCometFeedRegularStoriesPaginationQuery" },
};

const rule = (over: Partial<LeadRule> = {}): LeadRule => ({
  id: "r1",
  groupIds: [],
  keywords: ["شقة"],
  minScore: 50,
  enabled: true,
  ...over,
});

/** A feed response shaped like Facebook's: stories nested under edges. */
function feed(posts: Array<{ id: string; text: string; author?: string }>) {
  return {
    data: {
      node: {
        group_feed: {
          edges: posts.map((p) => ({
            node: {
              post_id: p.id,
              url: `https://www.facebook.com/groups/1/posts/${p.id}/`,
              message: { text: p.text },
              actors: [
                {
                  id: p.author ?? "100000000001",
                  name: "Poster",
                  __typename: "User",
                  profile_url: "https://www.facebook.com/poster",
                },
              ],
            },
          })),
          page_info: { has_next_page: false },
        },
      },
    },
  };
}

function harness(responses: unknown[] | (() => unknown)) {
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
  const wakes: string[] = [];
  const cleared: string[] = [];
  const clock: ClockPort = {
    now: () => NOW,
    async scheduleWake(n) {
      wakes.push(n);
    },
    async clearWake(n) {
      cleared.push(n);
    },
  };
  const calls: Array<{ friendly?: string; vars: any }> = [];
  let i = 0;
  const http: HttpPort = {
    async fetch(_url, init) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ friendly: headers["x-fb-friendly-name"], vars: JSON.parse(body.get("variables") ?? "{}") });
      const next = typeof responses === "function" ? responses() : responses[i++ % responses.length];
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next));
    },
  };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const upserts: Array<{ id: string; contacts: number }> = [];
  const audience = {
    async upsert(person: { id: string }, _s: unknown, contacts: unknown[]) {
      upserts.push({ id: person.id, contacts: contacts.length });
      return { isNew: true, gainedContact: contacts.length > 0 };
    },
  } as unknown as AudienceStore;
  const notified: Array<{ title: string; message: string }> = [];

  const ports: RadarPorts = {
    storage,
    http,
    clock,
    logger,
    audience,
    async notify(title, message) {
      notified.push({ title, message });
    },
  };
  // sleep stubbed: the pacing is the governor's job to enforce, not this test's to wait for.
  return { svc: new LeadRadarService(ports, async () => {}), calls, wakes, cleared, notified, upserts };
}

const groups = new Map<string, Group>([
  ["g1", { id: "g1", name: "Riyadh Rentals", url: "" } as Group],
  ["g2", { id: "g2", name: "Jeddah Rentals", url: "" } as Group],
]);

describe("configure", () => {
  it("is off until enabled, and arms/clears its alarm", async () => {
    const { svc, wakes, cleared } = harness([feed([])]);
    expect((await svc.getState()).config.enabled).toBe(false);
    await svc.configure({ enabled: true });
    expect(wakes).toContain(ALARM_RADAR);
    await svc.configure({ enabled: false });
    expect(cleared).toContain(ALARM_RADAR);
  });
});

describe("tick", () => {
  const enable = async (svc: LeadRadarService, over: Partial<Parameters<LeadRadarService["configure"]>[0]> = {}) =>
    svc.configure({
      enabled: true,
      rules: [rule()],
      watchedGroupIds: ["g1"],
      notify: true,
      ...over,
    });

  it("does nothing while disabled", async () => {
    const { svc, calls } = harness([feed([])]);
    expect(await svc.tick(TOKENS, RECIPE, groups, NOW)).toMatchObject({ skipped: "disabled" });
    expect(calls).toEqual([]);
  });

  it("reports unsupported when the recipe has no group-feed doc_id", async () => {
    const { svc, calls } = harness([feed([])]);
    await enable(svc);
    const res = await svc.tick(TOKENS, DEFAULT_FB_RECIPE, groups, NOW);
    expect(res.skipped).toBe("unsupported");
    expect(calls).toEqual([]);
    expect((await svc.getState()).unsupported).toBe(true);
  });

  it("waits for a session rather than opening a tab", async () => {
    const { svc, calls } = harness([feed([])]);
    await enable(svc);
    expect(await svc.tick(null, RECIPE, groups, NOW)).toMatchObject({ skipped: "no_session" });
    expect(calls).toEqual([]);
  });

  it("skips when nothing is watched or every rule is off", async () => {
    const { svc } = harness([feed([])]);
    await enable(svc, { watchedGroupIds: [] });
    expect((await svc.tick(TOKENS, RECIPE, groups, NOW)).skipped).toBe("nothing_watched");
    await enable(svc, { rules: [rule({ enabled: false })] });
    expect((await svc.tick(TOKENS, RECIPE, groups, NOW)).skipped).toBe("nothing_watched");
  });

  it("finds a buyer and ignores a seller in the same feed", async () => {
    const { svc, notified } = harness([
      feed([
        { id: "p1", text: "ابحث عن شقة في الرياض ضروري؟" },
        { id: "p2", text: "شقة للايجار، تواصل معنا للحجز" },
      ]),
    ]);
    await enable(svc);
    const res = await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(res.found).toBe(1);
    const [m] = await svc.matches();
    expect(m?.id).toBe("p1");
    expect(m?.groupName).toBe("Riyadh Rentals");
    expect(notified).toHaveLength(1);
  });

  it("carries the friendly name so the governor can bill the sweep", async () => {
    const { svc, calls } = harness([feed([])]);
    await enable(svc);
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(calls[0]?.friendly).toBe(RECIPE.groupFeed?.friendlyName);
    expect(calls[0]?.vars).toMatchObject({ id: "g1" });
  });

  it("never notifies about the same post twice", async () => {
    const { svc, notified } = harness(() => feed([{ id: "p1", text: "ابحث عن شقة ضروري؟" }]));
    await enable(svc);
    expect((await svc.tick(TOKENS, RECIPE, groups, NOW)).found).toBe(1);
    // A radar that re-announces yesterday's post gets muted, and a muted radar is
    // worth nothing.
    expect((await svc.tick(TOKENS, RECIPE, groups, NOW)).found).toBe(0);
    expect(notified).toHaveLength(1);
  });

  it("sends one notification per sweep, not one per match", async () => {
    const { svc, notified } = harness([
      feed([
        { id: "p1", text: "ابحث عن شقة في الرياض ضروري؟" },
        { id: "p2", text: "محتاج شقة بسرعة، كم سعر؟" },
      ]),
    ]);
    await enable(svc);
    expect((await svc.tick(TOKENS, RECIPE, groups, NOW)).found).toBe(2);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.title).toContain("2");
  });

  it("stays silent when notifications are off", async () => {
    const { svc, notified } = harness([feed([{ id: "p1", text: "ابحث عن شقة ضروري؟" }])]);
    await enable(svc, { notify: false });
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(notified).toEqual([]);
  });

  it("finds no numbers when no region is set, rather than guessing a country", async () => {
    const { svc, upserts } = harness([
      feed([{ id: "p1", text: "ابحث عن شقة، واتساب ٠٥٥١٢٣٤٥٦٧" }]),
    ]);
    await enable(svc);
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(upserts).toEqual([]);
  });

  it("keeps a contact the poster typed into the post itself", async () => {
    const { svc, upserts } = harness([
      feed([{ id: "p1", text: "ابحث عن شقة، واتساب ٠٥٥١٢٣٤٥٦٧" }]),
    ]);
    await enable(svc, { defaultRegion: "SA" });
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.contacts).toBeGreaterThan(0);
  });

  it("sweeps a bounded batch and rotates the cursor across wakes", async () => {
    const watched = ["g1", "g2", "g3", "g4", "g5", "g6"];
    const { svc, calls } = harness(() => feed([]));
    await enable(svc, { watchedGroupIds: watched });
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(calls).toHaveLength(GROUPS_PER_TICK);
    const first = calls.map((c) => c.vars.id);
    calls.length = 0;
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    // Different groups next wake, so all six are reached rather than the first four
    // being swept forever.
    expect(calls.map((c) => c.vars.id)).not.toEqual(first);
  });

  it("stops the sweep when Facebook pushes back, and resumes next wake", async () => {
    let n = 0;
    const { svc, calls } = harness(() => {
      if (n++ === 1) return new Error("ThrottledError: cooldown");
      return feed([]);
    });
    await enable(svc, { watchedGroupIds: ["g1", "g2", "g3", "g4"] });
    const res = await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(res.swept).toBe(1);
    expect(calls.length).toBeLessThan(GROUPS_PER_TICK);
  });

  it("caps the match list — this is an inbox, not an archive", async () => {
    let i = 0;
    const { svc } = harness(() =>
      feed(
        Array.from({ length: 50 }, () => ({ id: `p${i++}`, text: "ابحث عن شقة ضروري؟" })),
      ),
    );
    await enable(svc);
    for (let k = 0; k < 6; k++) await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect((await svc.matches()).length).toBeLessThanOrEqual(MAX_MATCHES);
  });

  it("re-arms even when it did nothing", async () => {
    const { svc, wakes } = harness([feed([])]);
    await enable(svc);
    const before = wakes.length;
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    expect(wakes.length).toBeGreaterThan(before);
  });
});

describe("markHandled / clearMatches", () => {
  it("marks one and clears all", async () => {
    const { svc } = harness([feed([{ id: "p1", text: "ابحث عن شقة ضروري؟" }])]);
    await svc.configure({ enabled: true, rules: [rule()], watchedGroupIds: ["g1"], notify: false });
    await svc.tick(TOKENS, RECIPE, groups, NOW);
    await svc.markHandled("p1");
    expect((await svc.matches())[0]?.handled).toBe(true);
    await svc.clearMatches();
    expect(await svc.matches()).toEqual([]);
  });
});

describe("parseFeed", () => {
  it("finds stories however they are nested", () => {
    const out = parseFeed(feed([{ id: "p1", text: "hello" }]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "p1", text: "hello" });
    expect(out[0]?.author?.name).toBe("Poster");
  });

  it("ignores a story with no text", () => {
    expect(parseFeed({ data: { edges: [{ node: { post_id: "p1", message: null } }] } })).toEqual([]);
  });

  it("does not report an attached story as a second post", () => {
    const nested = {
      data: {
        edges: [
          {
            node: {
              post_id: "outer",
              message: { text: "outer text" },
              attached_story: { post_id: "inner", message: { text: "inner text" } },
            },
          },
        ],
      },
    };
    expect(parseFeed(nested).map((p) => p.id)).toEqual(["outer"]);
  });

  it("returns nothing rather than throwing on junk", () => {
    expect(parseFeed(null)).toEqual([]);
    expect(parseFeed({})).toEqual([]);
    expect(parseFeed({ data: { errors: [{ message: "x" }] } })).toEqual([]);
  });
});
