import { describe, expect, it } from "vitest";
import { DEFAULT_FB_RECIPE, type FbRecipe } from "@nashir/shared";
import {
  DEFAULT_CALL_BUDGET,
  advance,
  budgetVerdict,
  classifyEndpoint,
  countsFor,
  detectThrottle,
  domainOf,
  emptyRing,
  isMutation,
  jittered,
  nextCooldownMs,
  opensCooldown,
  recordCall,
  spacingFor,
  withBudgetOverrides,
} from "./governorMath.js";

const R = DEFAULT_FB_RECIPE;
const MIN = 60_000;

/** A deterministic 0..1 source, cycling the values given. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length]!;
};

describe("domainOf", () => {
  it("separates the upload edge from www", () => {
    expect(domainOf("https://www.facebook.com/api/graphql/")).toBe("www");
    expect(domainOf("https://facebook.com/x")).toBe("www");
    expect(domainOf("https://upload.facebook.com/ajax/x")).toBe("upload");
    expect(domainOf("https://vupload2.facebook.com/ajax/video/upload/requests/start/")).toBe(
      "upload",
    );
    expect(domainOf("https://vupload-edge.facebook.com/x")).toBe("upload");
  });

  it("returns null for a non-Facebook host and for anything else", () => {
    expect(domainOf("https://example.com/data.json")).toBeNull();
    expect(domainOf("https://notfacebook.com/x")).toBeNull();
    expect(domainOf("https://evil-facebook.com.attacker.test/x")).toBeNull();
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("classifyEndpoint", () => {
  const gql = "https://www.facebook.com/api/graphql/";

  it("uses the recipe's own friendly names", () => {
    expect(classifyEndpoint(gql, R.createGroupPost.friendlyName, R)?.cls).toBe("mutation.post");
    expect(classifyEndpoint(gql, R.leaveGroup?.friendlyName, R)?.cls).toBe("mutation.leave");
    expect(classifyEndpoint(gql, R.leaveGroupDialog?.friendlyName, R)?.cls).toBe("read.dialog");
    expect(classifyEndpoint(gql, R.joinedGroups.friendlyName, R)?.cls).toBe("read.groups");
    expect(classifyEndpoint(gql, R.joinedGroupsPagination?.friendlyName, R)?.cls).toBe(
      "read.groups",
    );
  });

  it("falls back to heuristics for a query the recipe has never heard of", () => {
    expect(classifyEndpoint(gql, "SomeComposerStoryCreateMutation")?.cls).toBe("mutation.post");
    expect(classifyEndpoint(gql, "useGroupLeaveMutation")?.cls).toBe("mutation.leave");
    expect(classifyEndpoint(gql, "CometGroupsQuery")?.cls).toBe("read.groups");
    expect(classifyEndpoint(gql, "MysteryQuery")?.cls).toBe("other");
    expect(classifyEndpoint(gql, undefined)?.cls).toBe("other");
  });

  it("splits photo from video by upload host", () => {
    expect(classifyEndpoint("https://upload.facebook.com/ajax/x")?.cls).toBe("upload.photo");
    expect(classifyEndpoint("https://vupload2.facebook.com/ajax/x")?.cls).toBe("upload.video");
  });

  it("is null for a non-Facebook host, so other traffic is never governed", () => {
    expect(classifyEndpoint("https://example.com/data.json")).toBeNull();
  });

  it("knows which classes are mutations", () => {
    expect(isMutation("mutation.post")).toBe(true);
    expect(isMutation("mutation.leave")).toBe(true);
    expect(isMutation("read.groups")).toBe(false);
    expect(isMutation("upload.video")).toBe(false);
  });
});

describe("detectThrottle — the incident", () => {
  it("classifies the exact dialog the user was shown", () => {
    const body =
      'for (;;);{"__ar":1,"error":1357004,"errorSummary":"Too many API requests",' +
      '"errorDescription":"There have been too many calls from this app. Wait a bit and try again.",' +
      '"payload":null}';
    const v = detectThrottle({ status: 200, bodyText: body, recipe: R });
    expect(v.class).toBe("rate_limit");
    expect(v.scope).toBe("global");
    expect(v.evidence).toContain("too many calls from this app");
  });

  it("still classifies it with no headers at all — the internal-endpoint reality", () => {
    const v = detectThrottle({
      status: 200,
      headers: {},
      bodyText: '{"errors":[{"message":"Too many API requests"}]}',
      recipe: R,
    });
    expect(v.class).toBe("rate_limit");
  });
});

describe("detectThrottle — codes", () => {
  const withCode = (code: number, extra: Record<string, unknown> = {}) =>
    detectThrottle({
      status: 200,
      bodyText: JSON.stringify({ errors: [{ code, message: "x", ...extra }] }),
      recipe: R,
    });

  it("reads the app-wide rate-limit codes as global", () => {
    for (const c of [4, 32, 341, 613]) {
      const v = withCode(c);
      expect(v.class, "code " + c).toBe("rate_limit");
      expect(v.scope, "code " + c).toBe("global");
    }
  });

  it("scopes code 17 to the account, because it is the user's own quota", () => {
    const v = withCode(17);
    expect(v.class).toBe("rate_limit");
    expect(v.scope).toBe("account");
  });

  it("matches the business-use-case range by span", () => {
    expect(withCode(80003).class).toBe("rate_limit");
    expect(withCode(80999).class).toBe("rate_limit");
    expect(withCode(81000).class).not.toBe("rate_limit");
  });

  it("separates a policy block from a rate limit", () => {
    expect(withCode(368).class).toBe("policy_block");
  });

  it("treats a checkpoint as its own, account-scoped thing", () => {
    const v = withCode(601);
    expect(v.class).toBe("checkpoint");
    expect(v.scope).toBe("account");
  });

  it("carries the subcode through", () => {
    expect(withCode(4, { error_subcode: 1349001 }).subcode).toBe(1349001);
  });

  it("does NOT match a bare number in the text — codes are never substrings", () => {
    const v = detectThrottle({
      status: 200,
      bodyText: '{"data":{"story":{"id":"4"},"count":601,"note":"368 members"}}',
      recipe: R,
    });
    expect(v.class).toBe("none");
  });
});

describe("detectThrottle — copy", () => {
  const msg = (m: string) =>
    detectThrottle({ status: 200, bodyText: JSON.stringify({ errors: [{ message: m }] }), recipe: R });

  it("reads a temporary block as a policy block, not a 15-minute rate limit", () => {
    expect(msg("You're Temporarily Blocked from posting").class).toBe("policy_block");
    expect(msg("Your account is temporarily restricted").class).toBe("policy_block");
  });

  it("reads checkpoint copy as a checkpoint", () => {
    expect(msg("Please confirm your identity to continue").class).toBe("checkpoint");
    expect(msg("Go to the checkpoint page").class).toBe("checkpoint");
  });

  it("scopes user-attributed throttle copy to the account", () => {
    expect(msg("User request limit reached").scope).toBe("account");
    expect(msg("Application request limit reached").scope).toBe("global");
  });

  it("accepts a bare error string, which is how the catch paths call it", () => {
    expect(detectThrottle({ bodyText: "You are posting too frequently", recipe: R }).class).toBe(
      "rate_limit",
    );
  });

  it("leaves an ordinary failure alone", () => {
    expect(msg("Invalid group id").class).toBe("none");
    expect(detectThrottle({ status: 200, bodyText: '{"data":{"ok":1}}', recipe: R }).class).toBe(
      "none",
    );
  });

  it("ignores signals that are only digits, so no recipe entry can become a substring trap", () => {
    const recipe: FbRecipe = { ...R, rateLimitSignals: ["601"], rateLimitCodes: [] };
    expect(detectThrottle({ status: 200, bodyText: '{"errors":[{"message":"601"}]}', recipe }).class).toBe(
      "none",
    );
  });
});

describe("detectThrottle — status and headers", () => {
  it("treats 429 as a rate limit and honours Retry-After in seconds", () => {
    const v = detectThrottle({
      status: 429,
      headers: { "retry-after": "900" },
      bodyText: "",
      recipe: R,
    });
    expect(v.class).toBe("rate_limit");
    expect(v.retryAfterMs).toBe(900_000);
  });

  it("honours an HTTP-date Retry-After", () => {
    const now = Date.parse("2026-08-22T12:00:00Z");
    const v = detectThrottle(
      {
        status: 429,
        headers: { "retry-after": "Sat, 22 Aug 2026 12:05:00 GMT" },
        recipe: R,
      },
      now,
    );
    expect(v.retryAfterMs).toBe(5 * MIN);
  });

  it("reads estimated_time_to_regain_access out of the business-use-case header", () => {
    const v = detectThrottle({
      status: 200,
      headers: {
        "x-business-use-case-usage": JSON.stringify({
          "123": [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 30 }],
        }),
      },
      bodyText: '{"errors":[{"code":4}]}',
      recipe: R,
    });
    expect(v.retryAfterMs).toBe(30 * MIN);
  });

  it("reports pressure from x-app-usage without calling it a throttle", () => {
    const v = detectThrottle({
      status: 200,
      headers: { "x-app-usage": JSON.stringify({ call_count: 85, total_time: 12 }) },
      bodyText: '{"data":{"ok":1}}',
      recipe: R,
    });
    expect(v.class).toBe("none");
    expect(v.pressure).toBeCloseTo(0.85);
  });

  it("survives a malformed usage header", () => {
    const v = detectThrottle({
      status: 200,
      headers: { "x-app-usage": "not json" },
      bodyText: '{"data":{}}',
      recipe: R,
    });
    expect(v.class).toBe("none");
    expect(v.pressure).toBeUndefined();
  });

  it("calls a 5xx transient, which is a retry rather than a cooldown", () => {
    const v = detectThrottle({ status: 503, bodyText: "", recipe: R });
    expect(v.class).toBe("transient");
    expect(opensCooldown(v)).toBe(false);
  });

  it("lets a 200 carrying an error body outrank the clean status", () => {
    const v = detectThrottle({
      status: 200,
      bodyText: '{"errors":[{"code":4,"message":"Too many API requests"}]}',
      recipe: R,
    });
    expect(v.class).toBe("rate_limit");
  });

  it("recognises a network failure passed in as a bare message", () => {
    expect(detectThrottle({ bodyText: "Failed to fetch", recipe: R }).class).toBe("transient");
  });
});

describe("opensCooldown", () => {
  it("stops for a block and retries for a blip", () => {
    const of = (c: string) => opensCooldown({ class: c as never, scope: "global" });
    expect(of("rate_limit")).toBe(true);
    expect(of("policy_block")).toBe(true);
    expect(of("checkpoint")).toBe(true);
    expect(of("transient")).toBe(false);
    expect(of("none")).toBe(false);
  });
});

describe("nextCooldownMs", () => {
  const cfg = DEFAULT_CALL_BUDGET;

  it("uses equal jitter — never near zero, which would be a call straight back", () => {
    expect(nextCooldownMs(1, cfg, seq(0))).toBe(7.5 * MIN);
    expect(nextCooldownMs(1, cfg, seq(1))).toBe(15 * MIN);
  });

  it("climbs the ladder and caps at the last rung", () => {
    const hi = (n: number) => nextCooldownMs(n, cfg, seq(1));
    expect(hi(1)).toBe(15 * MIN);
    expect(hi(2)).toBe(60 * MIN);
    expect(hi(3)).toBe(4 * 60 * MIN);
    expect(hi(4)).toBe(12 * 60 * MIN);
    expect(hi(5)).toBe(24 * 60 * MIN);
    expect(hi(9)).toBe(24 * 60 * MIN);
  });

  it("lets a server-stated wait win over the ladder", () => {
    expect(nextCooldownMs(3, cfg, seq(0), 20 * MIN)).toBe(20 * MIN);
  });

  it("floors a short Retry-After at a minute — it is not permission to hammer", () => {
    expect(nextCooldownMs(1, cfg, seq(0), 2000)).toBe(MIN);
  });
});

describe("spacingFor", () => {
  it("keeps reads fast and mutations slow", () => {
    expect(spacingFor("read.groups", DEFAULT_CALL_BUDGET)).toBe(600);
    expect(spacingFor("mutation.post", DEFAULT_CALL_BUDGET)).toBe(30_000);
    expect(spacingFor("upload.video", DEFAULT_CALL_BUDGET)).toBe(250);
  });

  it("doubles everything once Facebook says we are near its ceiling", () => {
    expect(spacingFor("read.groups", DEFAULT_CALL_BUDGET, 0.85)).toBe(1200);
    expect(spacingFor("read.groups", DEFAULT_CALL_BUDGET, 0.5)).toBe(600);
  });
});

describe("jittered", () => {
  it("spans the configured fraction either side", () => {
    expect(jittered(1000, 0.3, seq(0))).toBe(700);
    expect(jittered(1000, 0.3, seq(1))).toBe(1300);
    expect(jittered(1000, 0.3, seq(0.5))).toBe(1000);
  });
});

describe("withBudgetOverrides", () => {
  it("merges nested records rather than replacing them wholesale", () => {
    const merged = withBudgetOverrides(DEFAULT_CALL_BUDGET, {
      spacingMs: { "read.groups": 2000 } as never,
      perAccountPerHour: 10,
    });
    expect(merged.spacingMs["read.groups"]).toBe(2000);
    expect(merged.spacingMs["mutation.post"]).toBe(30_000);
    expect(merged.perAccountPerHour).toBe(10);
  });

  it("is a no-op with nothing to override", () => {
    expect(withBudgetOverrides(DEFAULT_CALL_BUDGET)).toBe(DEFAULT_CALL_BUDGET);
  });
});

describe("the ring", () => {
  const T0 = 1_800_000_000_000;
  const always = () => 0.5;

  it("counts a call against the minute and the hour", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", "acct", T0);
    recordCall(ring, "www", "read.groups", "acct", T0);
    expect(countsFor(ring, "www")).toEqual({ minute: 2, hour: 2 });
    expect(countsFor(ring, "upload")).toEqual({ minute: 0, hour: 0 });
  });

  it("rolls the minute over without losing the hour", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", undefined, T0);
    advance(ring, T0 + 5 * MIN);
    expect(countsFor(ring, "www")).toEqual({ minute: 0, hour: 1 });
  });

  it("forgets everything older than the hour it tracks", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", undefined, T0);
    advance(ring, T0 + 61 * MIN);
    expect(countsFor(ring, "www").hour).toBe(0);
  });

  it("survives a long idle gap without smearing stale counts across the ring", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", undefined, T0);
    advance(ring, T0 + 10_000 * MIN);
    expect(countsFor(ring, "www").hour).toBe(0);
  });
});

describe("budgetVerdict", () => {
  const T0 = 1_800_000_000_000;
  const cfg = DEFAULT_CALL_BUDGET;
  const mid = () => 0.5;

  it("allows the first call of a class immediately", () => {
    const ring = emptyRing(T0);
    expect(budgetVerdict(ring, "www", "read.groups", undefined, T0, cfg, mid).allowed).toBe(true);
  });

  it("holds the next call of the same class for the spacing", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", undefined, T0);
    const v = budgetVerdict(ring, "www", "read.groups", undefined, T0 + 100, cfg, mid);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("spacing");
    expect(v.waitMs).toBe(500);
  });

  it("lets a different class through while one is spacing — uploads never wait on reads", () => {
    const ring = emptyRing(T0);
    recordCall(ring, "www", "read.groups", undefined, T0);
    expect(budgetVerdict(ring, "upload", "upload.video", undefined, T0 + 1, cfg, mid).allowed).toBe(
      true,
    );
  });

  it("refuses past the per-minute ceiling and points at the next minute", () => {
    const ring = emptyRing(T0);
    for (let i = 0; i < cfg.perDomain.www.perMinute; i++) {
      recordCall(ring, "www", "other", undefined, T0);
    }
    const v = budgetVerdict(ring, "www", "read.groups", undefined, T0, cfg, mid);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("minute_budget");
    expect(v.retryAtMs).toBe((Math.floor(T0 / MIN) + 1) * MIN);
  });

  it("refuses past the hourly ceiling", () => {
    const ring = emptyRing(T0);
    // Spread five a minute across fifty minutes, so the per-minute cap is not what trips.
    const perMinute = 5;
    const minutes = cfg.perDomain.www.perHour / perMinute;
    let t = T0;
    for (let m = 0; m < minutes; m++) {
      t = T0 + m * MIN;
      for (let i = 0; i < perMinute; i++) recordCall(ring, "www", "other", undefined, t);
    }
    expect(countsFor(ring, "www").hour).toBe(cfg.perDomain.www.perHour);
    const v = budgetVerdict(ring, "www", "read.groups", undefined, t, cfg, mid);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("hour_budget");
  });

  it("refuses past one account's hourly slice while the app as a whole is fine", () => {
    const ring = emptyRing(T0);
    const perMinute = 5;
    let t = T0;
    for (let m = 0; m < cfg.perAccountPerHour / perMinute; m++) {
      t = T0 + m * MIN;
      for (let i = 0; i < perMinute; i++) recordCall(ring, "www", "other", "acct-a", t);
    }
    expect(budgetVerdict(ring, "www", "read.groups", "acct-a", t, cfg, mid).reason).toBe(
      "account_budget",
    );
    expect(budgetVerdict(ring, "www", "read.groups", "acct-b", t, cfg, mid).allowed).toBe(true);
  });

  it("refuses everything while a cooldown is live, and says when it lifts", () => {
    const ring = emptyRing(T0);
    ring.cooldown = {
      since: T0,
      untilMs: T0 + 15 * MIN,
      scope: "global",
      reason: "rate_limit",
      evidence: "too many api requests",
      matchedSignal: "code:4",
      consecutive: 1,
      requiresOperator: false,
    };
    const v = budgetVerdict(ring, "www", "read.groups", undefined, T0 + MIN, cfg, mid);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("cooldown");
    expect(v.retryAtMs).toBe(T0 + 15 * MIN);
  });

  it("gives a checkpoint no finish line at all — only a person clears it", () => {
    const ring = emptyRing(T0);
    ring.cooldown = {
      since: T0,
      untilMs: T0 + MIN,
      scope: "account",
      reason: "checkpoint",
      evidence: "confirm your identity",
      matchedSignal: "code:601",
      consecutive: 1,
      requiresOperator: true,
    };
    const v = budgetVerdict(ring, "www", "read.groups", undefined, T0 + 10 * MIN, cfg, mid);
    expect(v.allowed).toBe(false);
    expect(v.waitMs).toBe(Number.POSITIVE_INFINITY);
    expect(v.retryAtMs).toBeUndefined();
  });

  it("reopens once an expired cooldown is behind us", () => {
    const ring = emptyRing(T0);
    ring.cooldown = {
      since: T0,
      untilMs: T0 + 15 * MIN,
      scope: "global",
      reason: "rate_limit",
      evidence: "x",
      matchedSignal: "code:4",
      consecutive: 1,
      requiresOperator: false,
    };
    expect(budgetVerdict(ring, "www", "read.groups", undefined, T0 + 16 * MIN, cfg, mid).allowed).toBe(
      true,
    );
  });
});
