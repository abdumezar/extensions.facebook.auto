import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FB_RECIPE } from "@nashir/shared";
import { CallGovernor, ThrottledError } from "./CallGovernor.js";
import { GovernedHttp } from "./GovernedHttp.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const GQL = "https://www.facebook.com/api/graphql/";
const OTHER_HOST = "https://example.com/data.json";
const T0 = 1_800_000_000_000;

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

const THROTTLE_BODY =
  'for (;;);{"error":1357004,"errorSummary":"Too many API requests",' +
  '"errorDescription":"There have been too many calls from this app. Wait a bit and try again."}';

function harness(opts: { bodies?: string[]; status?: number } = {}) {
  let t = T0;
  const clock: ClockPort = {
    now: () => t,
    scheduleWake: async () => {},
    clearWake: async () => {},
  };
  const waits: number[] = [];
  const urls: string[] = [];
  let i = 0;
  const inner: HttpPort = {
    fetch: async (url: string) => {
      urls.push(url);
      const body = opts.bodies?.[i++] ?? opts.bodies?.at(-1) ?? '{"data":{"ok":1}}';
      return new Response(body, {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const innerSpy = vi.spyOn(inner, "fetch");
  const storage = memStorage();
  const governor = new CallGovernor(
    storage,
    clock,
    noopLogger,
    DEFAULT_CALL_BUDGET,
    () => 0.5,
    async (ms) => {
      waits.push(ms);
      t += ms;
    },
  );
  const http = new GovernedHttp(
    inner,
    governor,
    async () => DEFAULT_FB_RECIPE,
    noopLogger,
    () => "acct-1",
  );
  return { http, governor, innerSpy, urls, waits, storage, advance: (ms: number) => void (t += ms) };
}

const graphql = (friendly: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": friendly },
  body: "x=1",
});

describe("GovernedHttp leaves non-Facebook hosts alone", () => {
  it("passes a non-Facebook call straight through", async () => {
    const h = harness();
    await h.http.fetch(OTHER_HOST);
    expect(h.innerSpy).toHaveBeenCalledTimes(1);
    expect((await h.governor.snapshot()).callsLastHour).toBe(0);
  });

  it("still reaches other hosts while Facebook is in cooldown", async () => {
    const h = harness({ bodies: [THROTTLE_BODY] });
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));
    expect(await h.governor.cooldown()).not.toBeNull();

    // The cooldown protects Facebook's limits only. Stopping unrelated traffic as well
    // would make a throttle spread to things that never caused it.
    await expect(h.http.fetch(OTHER_HOST)).resolves.toBeInstanceOf(Response);
  });
});

describe("GovernedHttp does not break the callers it wraps", () => {
  it("hands back a response whose body is still readable", async () => {
    const h = harness({ bodies: ['for (;;);{"data":{"story":{"id":"9"}}}'] });
    const res = await h.http.fetch(GQL, graphql("ComposerStoryCreateMutation"));

    // The decorator read the body to look for a throttle. Every parser in the engine
    // reads it again afterwards, so the clone must have left the original untouched.
    await expect(res.text()).resolves.toBe('for (;;);{"data":{"story":{"id":"9"}}}');
  });

  it("preserves the status and headers", async () => {
    const h = harness({ status: 404 });
    const res = await h.http.fetch(GQL, graphql("SomethingQuery"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("GovernedHttp paces what used to burst", () => {
  it("spaces a run of pagination calls instead of firing them back to back", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      await h.http.fetch(GQL, graphql(DEFAULT_FB_RECIPE.joinedGroupsPagination!.friendlyName));
    }
    expect(h.innerSpy).toHaveBeenCalledTimes(5);
    expect(h.waits).toEqual([600, 600, 600, 600]);
  });

  it("bills the call to the account whose cookies are installed", async () => {
    const h = harness();
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));
    expect((await h.governor.snapshot()).byAccount).toEqual({ "acct-1": 1 });
  });
});

describe("GovernedHttp stops when Facebook says stop", () => {
  /**
   * The rule the whole feature turns on. Meta's guidance is that calls made during a
   * block extend it, so a refusal has to reach the transport — not merely slow it.
   */
  it("does not touch the network at all on the call after a throttle", async () => {
    const h = harness({ bodies: [THROTTLE_BODY] });
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));
    expect(h.innerSpy).toHaveBeenCalledTimes(1);

    await expect(h.http.fetch(GQL, graphql("JoinedGroupsQuery"))).rejects.toThrow(ThrottledError);
    expect(h.innerSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies a throttle that arrives as HTTP 200, which is how the www endpoints send it", async () => {
    const h = harness({ bodies: [THROTTLE_BODY], status: 200 });
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));

    const cd = await h.governor.cooldown();
    expect(cd?.reason).toBe("rate_limit");
    expect(cd?.evidence).toContain("too many calls from this app");
  });

  it("blocks uploads too — the budget is the app's, not one subsystem's", async () => {
    const h = harness({ bodies: [THROTTLE_BODY] });
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));

    await expect(
      h.http.fetch("https://vupload2.facebook.com/ajax/video/upload/requests/post/", {
        method: "POST",
      }),
    ).rejects.toThrow(ThrottledError);
  });

  it("reopens by itself once the cooldown has run out", async () => {
    const h = harness({ bodies: [THROTTLE_BODY, '{"data":{"ok":1}}'] });
    await h.http.fetch(GQL, graphql("JoinedGroupsQuery"));
    h.advance(16 * 60_000);

    await expect(h.http.fetch(GQL, graphql("JoinedGroupsQuery"))).resolves.toBeInstanceOf(Response);
  });

  it("treats a network failure as evidence rather than swallowing it", async () => {
    let t = T0;
    const clock: ClockPort = { now: () => t, scheduleWake: async () => {}, clearWake: async () => {} };
    const inner: HttpPort = {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const governor = new CallGovernor(memStorage(), clock, noopLogger, DEFAULT_CALL_BUDGET, () => 0.5, async (ms) => void (t += ms));
    const http = new GovernedHttp(inner, governor, async () => DEFAULT_FB_RECIPE, noopLogger);

    await expect(http.fetch(GQL, graphql("JoinedGroupsQuery"))).rejects.toThrow("Failed to fetch");
    // Transient, so the caller may retry — but not a cooldown.
    expect(await governor.cooldown()).toBeNull();
  });
});

describe("GovernedHttp degrades safely", () => {
  it("still sends the request when the recipe cannot be read", async () => {
    let t = T0;
    const clock: ClockPort = { now: () => t, scheduleWake: async () => {}, clearWake: async () => {} };
    const inner: HttpPort = { fetch: async () => new Response('{"data":{}}') };
    const spy = vi.spyOn(inner, "fetch");
    const governor = new CallGovernor(memStorage(), clock, noopLogger);
    const http = new GovernedHttp(
      inner,
      governor,
      async () => {
        throw new Error("storage unavailable");
      },
      noopLogger,
    );

    await expect(http.fetch(GQL, graphql("JoinedGroupsQuery"))).resolves.toBeInstanceOf(Response);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not try to read a binary body", async () => {
    let t = T0;
    const clock: ClockPort = { now: () => t, scheduleWake: async () => {}, clearWake: async () => {} };
    const inner: HttpPort = {
      fetch: async () =>
        new Response("binary-ish", { headers: { "content-type": "application/octet-stream" } }),
    };
    const governor = new CallGovernor(memStorage(), clock, noopLogger);
    const http = new GovernedHttp(inner, governor, async () => DEFAULT_FB_RECIPE, noopLogger);

    const res = await http.fetch("https://upload.facebook.com/ajax/x", { method: "POST" });
    await expect(res.text()).resolves.toBe("binary-ish");
    expect(await governor.cooldown()).toBeNull();
  });
});
