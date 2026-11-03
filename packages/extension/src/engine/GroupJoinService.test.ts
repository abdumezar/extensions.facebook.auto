import { DEFAULT_FB_RECIPE, type FbRecipe, type SessionTokens } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import {
  GroupJoinService,
  MAX_JOINS_PER_BATCH,
  MAX_JOINS_PER_DAY,
  collectGroups,
  joinState,
} from "./GroupJoinService.js";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const TOKENS = { av: "1", user: "1", cometReq: "15", fb_dtsg: "d", jazoest: "2", lsd: "l" } as SessionTokens;
let NOW = 1_700_000_000_000;

/** The recipe as it will look once the two doc_ids are captured. */
const RECIPE: FbRecipe = {
  ...DEFAULT_FB_RECIPE,
  groupSearch: { docId: "1", friendlyName: "SearchCometResultsPaginatedResultsQuery" },
  joinGroup: { docId: "2", friendlyName: "useGroupsCometJoinMutation" },
};

const JOINED = { data: { group_join: { group: { id: "g1", join_state: "MEMBER" } } } };
const REQUESTED = { data: { group_join: { group: { id: "g1", join_state: "REQUESTED" } } } };

function harness(respond: (n: number) => unknown) {
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
  const calls: Array<{ friendly?: string; vars: any }> = [];
  let n = 0;
  const http: HttpPort = {
    async fetch(_url, init) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ friendly: headers["x-fb-friendly-name"], vars: JSON.parse(body.get("variables") ?? "{}") });
      const out = respond(n++);
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify(out));
    },
  };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // sleep stubbed: the spacing is the governor's to enforce, not this test's to wait for.
  return { svc: new GroupJoinService(storage, http, logger, () => NOW, async () => {}), calls, storage };
}

describe("support gates", () => {
  it("reports unsupported until the doc_ids are captured", async () => {
    const { svc, calls } = harness(() => JOINED);
    expect(svc.searchSupported(DEFAULT_FB_RECIPE)).toBe(false);
    expect(svc.joinSupported(DEFAULT_FB_RECIPE)).toBe(false);

    expect(await svc.search("شقق", TOKENS, DEFAULT_FB_RECIPE)).toMatchObject({ unsupported: true });
    const joins = await svc.join(["g1"], TOKENS, DEFAULT_FB_RECIPE);
    expect(joins[0]?.status).toBe("unsupported");
    expect(calls).toEqual([]);
  });
});

describe("search", () => {
  it("collects groups out of the response", async () => {
    const { svc, calls } = harness(() => ({
      data: {
        results: {
          edges: [
            { node: { __typename: "Group", id: "123456789", name: "شقق الرياض", url: "https://www.facebook.com/groups/123456789" } },
            { node: { __typename: "User", id: "999999999", name: "Not a group" } },
          ],
        },
      },
    }));
    const out = await svc.search("شقق", TOKENS, RECIPE);
    expect(out.groups.map((g) => g.id)).toEqual(["123456789"]);
    expect(calls[0]?.friendly).toBe(RECIPE.groupSearch?.friendlyName);
    expect(calls[0]?.vars.query).toBe("شقق");
  });
});

describe("join", () => {
  it("joins, and carries the friendly name so the governor bills a join", async () => {
    const { svc, calls } = harness(() => JOINED);
    const out = await svc.join(["g1"], TOKENS, RECIPE);
    expect(out[0]).toMatchObject({ groupId: "g1", status: "joined" });
    expect(calls[0]?.friendly).toBe(RECIPE.joinGroup?.friendlyName);
  });

  it("does not report a pending request as membership", async () => {
    // A closed group answers with a request, not a membership. Conflating them puts a
    // group the operator cannot post to into their campaign list.
    const { svc } = harness(() => REQUESTED);
    expect((await svc.join(["g1"], TOKENS, RECIPE))[0]?.status).toBe("requested");
  });

  it("caps one batch and says what it skipped", async () => {
    const { svc } = harness(() => JOINED);
    const ids = Array.from({ length: MAX_JOINS_PER_BATCH + 2 }, (_, i) => `g${i}`);
    const out = await svc.join(ids, TOKENS, RECIPE);
    expect(out.filter((r) => r.status === "joined")).toHaveLength(MAX_JOINS_PER_BATCH);
    // A silent stop reads as success, so the rest are reported as skipped.
    expect(out.filter((r) => r.status === "skipped")).toHaveLength(2);
    expect(out).toHaveLength(ids.length);
  });

  it("enforces a rolling daily cap across batches", async () => {
    const { svc } = harness(() => JOINED);
    expect(await svc.remainingToday()).toBe(MAX_JOINS_PER_DAY);
    for (let i = 0; i < Math.ceil(MAX_JOINS_PER_DAY / MAX_JOINS_PER_BATCH) + 1; i++) {
      await svc.join(["a", "b", "c"], TOKENS, RECIPE);
    }
    expect(await svc.remainingToday()).toBe(0);
    const out = await svc.join(["z"], TOKENS, RECIPE);
    expect(out[0]).toMatchObject({ status: "skipped", error: "daily_cap" });
  });

  it("lets the cap roll off after a day", async () => {
    const { svc } = harness(() => JOINED);
    await svc.join(["a", "b", "c"], TOKENS, RECIPE);
    expect(await svc.remainingToday()).toBe(MAX_JOINS_PER_DAY - 3);
    NOW += 25 * 60 * 60 * 1000;
    expect(await svc.remainingToday()).toBe(MAX_JOINS_PER_DAY);
    NOW -= 25 * 60 * 60 * 1000;
  });

  it("aborts after repeated failures rather than working through the list", async () => {
    const { svc, calls } = harness(() => ({ errors: [{ message: "You can't join right now" }] }));
    const out = await svc.join(["a", "b", "c"], TOKENS, RECIPE);
    expect(calls).toHaveLength(2);
    expect(out.filter((r) => r.status === "failed")).toHaveLength(2);
  });

  it("stops the batch on a throttle", async () => {
    const { svc, calls } = harness((n) => (n === 0 ? JOINED : new Error("ThrottledError")));
    const out = await svc.join(["a", "b", "c"], TOKENS, RECIPE);
    expect(calls).toHaveLength(2);
    expect(out[0]?.status).toBe("joined");
    expect(out[1]?.status).toBe("failed");
  });

  it("counts an attempt against the cap even when it failed", async () => {
    // Facebook counted the call whatever it answered; pretending otherwise turns a
    // failing join loop into an unbounded source of the riskiest traffic we send.
    const { svc } = harness(() => ({ errors: [{ message: "nope" }] }));
    await svc.join(["a"], TOKENS, RECIPE);
    expect(await svc.remainingToday()).toBe(MAX_JOINS_PER_DAY - 1);
  });
});

describe("joinState", () => {
  it("reads membership and requests apart", () => {
    expect(joinState({ join_state: "MEMBER" })).toBe("joined");
    expect(joinState({ viewer_join_state: "JOINED" })).toBe("joined");
    expect(joinState({ request_to_join_state: "REQUESTED" })).toBe("requested");
    expect(joinState({ join_state: "PENDING" })).toBe("requested");
  });

  it("defaults to the cautious answer when it cannot tell", () => {
    expect(joinState({})).toBe("requested");
    expect(joinState(null)).toBe("requested");
  });
});

describe("collectGroups", () => {
  it("accepts a group identified by url or join state, not only __typename", () => {
    expect(collectGroups({ x: { id: "123456", name: "A", url: "https://x/groups/123456" } })).toHaveLength(1);
    expect(collectGroups({ x: { id: "123456", name: "A", viewer_join_state: "MEMBER" } })).toHaveLength(1);
  });

  it("rejects short ids and unnamed nodes", () => {
    expect(collectGroups({ x: { id: "12", name: "A", __typename: "Group" } })).toEqual([]);
    expect(collectGroups({ x: { id: "123456", __typename: "Group" } })).toEqual([]);
  });

  it("dedupes and survives junk", () => {
    const dup = { __typename: "Group", id: "123456", name: "A" };
    expect(collectGroups({ a: dup, b: { ...dup } })).toHaveLength(1);
    expect(collectGroups(null)).toEqual([]);
  });
});
