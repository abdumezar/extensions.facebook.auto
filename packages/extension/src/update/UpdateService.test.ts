import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRequestSchema, type UpdateState } from "@nashir/shared";
import { UpdateService } from "./UpdateService.js";
import { handleUiRequest } from "../background/messageRouter.js";
import type { HttpPort, StoragePort } from "../engine/ports/index.js";

// The router reaches the container only through this seam; the container itself needs chrome.
const stub = vi.hoisted(() => ({
  updates: null as null | { getState(): Promise<unknown>; check(): Promise<unknown> },
}));
vi.mock("../background/container.js", () => ({ container: () => ({ updates: stub.updates }) }));

const RELEASES_URL = "https://api.github.com/repos/owner/repo/releases/latest";
const NOW = 1_700_000_000_000;
const MIN = 60_000;

function memory() {
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
  return { map, storage };
}

type Asset = { name: string; browser_download_url: string };

const download = (tag: string, name: string) =>
  `https://github.com/owner/repo/releases/download/${tag}/${name}`;

const asset = (version: string, suffix: string, url?: string): Asset => {
  const name = suffix === "SHA256SUMS" ? suffix : `nashir-${version}.${suffix}`;
  return { name, browser_download_url: url ?? download(`v${version}`, name) };
};

function release(version: string, assets?: Asset[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    published_at: "2026-11-01T10:00:00Z",
    html_url: `https://github.com/owner/repo/releases/tag/v${version}`,
    assets: assets ?? [asset(version, "zip"), asset(version, "zip.sig"), asset(version, "SHA256SUMS")],
    ...extra,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(
  initial: () => Response | Promise<Response>,
  current = "1.0.0",
  releasesUrl = RELEASES_URL,
) {
  const { storage, map } = memory();
  const clock = { t: NOW };
  let respond = initial;
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => respond());
  const http: HttpPort = { fetch };
  const service = new UpdateService(http, storage, releasesUrl, () => current, () => clock.t);
  return {
    service,
    fetch,
    map,
    storage,
    clock,
    respondWith: (next: () => Response | Promise<Response>) => {
      respond = next;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("UpdateService", () => {
  it("offers a newer release with zip and sig urls", async () => {
    const { service, fetch } = setup(() => json(release("1.0.1")));
    const state = await service.check();
    expect(state).toEqual({
      status: "available",
      current: "1.0.0",
      checkedAt: NOW,
      latest: {
        version: "1.0.1",
        publishedAt: "2026-11-01T10:00:00Z",
        notesUrl: "https://github.com/owner/repo/releases/tag/v1.0.1",
        zipUrl: download("v1.0.1", "nashir-1.0.1.zip"),
        sigUrl: download("v1.0.1", "nashir-1.0.1.zip.sig"),
      },
    });
    expect(fetch.mock.calls[0]![0]).toBe(RELEASES_URL);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(fetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits publishedAt when the release has none", async () => {
    const { service } = setup(() => json(release("1.0.1", undefined, { published_at: null })));
    const state = await service.check();
    expect(state.latest).toBeDefined();
    expect(state.latest).not.toHaveProperty("publishedAt");
  });

  it("same version is idle", async () => {
    const { service } = setup(() => json(release("1.0.0")));
    expect(await service.check()).toEqual({ status: "idle", current: "1.0.0", checkedAt: NOW });
  });

  it("an older release is idle", async () => {
    const { service } = setup(() => json(release("0.9.0")));
    expect((await service.check()).status).toBe("idle");
  });

  it("rate limit is an error state", async () => {
    const { service } = setup(() =>
      json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    expect(await service.check()).toEqual({
      status: "error",
      current: "1.0.0",
      checkedAt: NOW,
      error: "rate_limited",
    });
  });

  it("a 403 that is not a rate limit is not reported as one", async () => {
    const { service } = setup(() =>
      json({ message: "forbidden" }, 403, { "x-ratelimit-remaining": "42" }),
    );
    expect((await service.check()).error).toBe("offline");
  });

  it("a bare 429 is a transient failure", async () => {
    const { service } = setup(() => json({ message: "slow down" }, 429));
    expect(await service.check()).toMatchObject({ status: "error", error: "offline" });
  });

  it("a server error is a transient failure", async () => {
    const { service } = setup(() => json({ message: "bad gateway" }, 502));
    expect(await service.check()).toMatchObject({ status: "error", error: "offline" });
  });

  it("a missing release is an error state", async () => {
    const { service } = setup(() => json({ message: "Not Found" }, 404));
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("release without signature is not offered", async () => {
    const { service } = setup(() => json(release("1.0.1", [asset("1.0.1", "zip")])));
    const state = await service.check();
    expect(state).toMatchObject({ status: "error", error: "unsigned_release" });
    expect(state.latest).toBeUndefined();
  });

  it("release without a zip is not offered", async () => {
    const { service } = setup(() => json(release("1.0.1", [asset("1.0.1", "zip.sig")])));
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("assets of another version are not taken for this release", async () => {
    const { service } = setup(() =>
      json(release("1.0.2", [asset("1.0.1", "zip"), asset("1.0.1", "zip.sig")])),
    );
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("network failure is offline", async () => {
    const { service } = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await service.check()).toEqual({
      status: "error",
      current: "1.0.0",
      checkedAt: NOW,
      error: "offline",
    });
  });

  it("an unreadable body is an error state, not a throw", async () => {
    const { service } = setup(() => new Response("<html>", { status: 200 }));
    expect(await service.check()).toMatchObject({ status: "error", error: "offline" });
  });

  it("a release with an unparseable tag is no release", async () => {
    const { service } = setup(() => json({ ...release("1.0.1"), tag_name: "nightly" }));
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("a request that never answers times out as offline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { service } = setup(() => new Promise<Response>(() => {}));
    const pending = service.check();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: "error", error: "offline" });
  });

  it("stores the result and getState reads it without the network", async () => {
    const { service, fetch } = setup(() => json(release("1.0.1")));
    await service.check();
    fetch.mockClear();
    expect((await service.getState()).status).toBe("available");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("getState is idle before any check", async () => {
    const { service } = setup(() => json(release("1.0.1")));
    expect(await service.getState()).toEqual({ status: "idle", current: "1.0.0" });
  });

  it("a stored result from an older running version is discarded", async () => {
    const { storage, map } = memory();
    const before = new UpdateService(
      { fetch: async () => json(release("1.0.1")) },
      storage,
      RELEASES_URL,
      () => "1.0.0",
      () => NOW,
    );
    await before.check();
    expect(map.get("nashir:update")).toBeTruthy();
    const after = new UpdateService({ fetch: vi.fn() }, storage, RELEASES_URL, () => "1.0.1", () => NOW);
    expect(await after.getState()).toEqual({ status: "idle", current: "1.0.1" });
  });

  it("concurrent checks share one request", async () => {
    const { service, fetch } = setup(() => json(release("1.0.1")));
    await Promise.all([service.check(), service.check()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateService asset trust", () => {
  const withAssets = (zip: string, sig: string, extra: Record<string, unknown> = {}) =>
    json(
      release(
        "1.0.1",
        [asset("1.0.1", "zip", zip), asset("1.0.1", "zip.sig", sig)],
        extra,
      ),
    );
  const good = (name: string) => download("v1.0.1", name);

  it("refuses a zip on a foreign host", async () => {
    const { service } = setup(() =>
      withAssets("https://evil.example/nashir-1.0.1.zip", good("nashir-1.0.1.zip.sig")),
    );
    const state = await service.check();
    expect(state).toMatchObject({ status: "error", error: "no_release" });
    expect(JSON.stringify(state)).not.toContain("evil.example");
  });

  it("refuses a signature on a foreign host", async () => {
    const { service } = setup(() =>
      withAssets(good("nashir-1.0.1.zip"), "https://evil.example/nashir-1.0.1.zip.sig"),
    );
    const state = await service.check();
    expect(state).toMatchObject({ status: "error", error: "unsigned_release" });
    expect(JSON.stringify(state)).not.toContain("evil.example");
  });

  it("refuses a non-https url", async () => {
    const { service } = setup(() =>
      withAssets(
        "http://github.com/owner/repo/releases/download/v1.0.1/nashir-1.0.1.zip",
        good("nashir-1.0.1.zip.sig"),
      ),
    );
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("refuses a github.com url of another repository", async () => {
    const { service } = setup(() =>
      withAssets(
        "https://github.com/someone/else/releases/download/v1.0.1/nashir-1.0.1.zip",
        good("nashir-1.0.1.zip.sig"),
      ),
    );
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });

  it("refuses a url under a different tag than the release's", async () => {
    const { service } = setup(() =>
      withAssets(
        good("nashir-1.0.1.zip"),
        "https://github.com/owner/repo/releases/download/v0.0.1/nashir-1.0.1.zip.sig",
      ),
    );
    expect(await service.check()).toMatchObject({ status: "error", error: "unsigned_release" });
  });

  it("builds the notes url itself and ignores html_url", async () => {
    const { service } = setup(() =>
      withAssets(good("nashir-1.0.1.zip"), good("nashir-1.0.1.zip.sig"), {
        html_url: "javascript:alert(1)",
      }),
    );
    const state = await service.check();
    expect(state.status).toBe("available");
    expect(state.latest?.notesUrl).toBe("https://github.com/owner/repo/releases/tag/v1.0.1");
  });

  it("accepts urls on the override origin when the api url is not GitHub's", async () => {
    const origin = "http://127.0.0.1:4567";
    const { service } = setup(
      () =>
        withAssets(`${origin}/assets/nashir-1.0.1.zip`, `${origin}/assets/nashir-1.0.1.zip.sig`),
      "1.0.0",
      `${origin}/releases/latest`,
    );
    const state = await service.check();
    expect(state.status).toBe("available");
    expect(state.latest?.zipUrl).toBe(`${origin}/assets/nashir-1.0.1.zip`);
    expect(state.latest?.notesUrl.startsWith(`${origin}/`)).toBe(true);
  });

  it("an override origin does not make other hosts acceptable", async () => {
    const origin = "http://127.0.0.1:4567";
    const { service } = setup(
      () => withAssets(good("nashir-1.0.1.zip"), `${origin}/assets/nashir-1.0.1.zip.sig`),
      "1.0.0",
      `${origin}/releases/latest`,
    );
    expect(await service.check()).toMatchObject({ status: "error", error: "no_release" });
  });
});

describe("UpdateService transient failures", () => {
  const available = async () => {
    const ctx = setup(() => json(release("1.0.1")));
    await ctx.service.check();
    ctx.clock.t = NOW + 60 * MIN;
    return ctx;
  };

  it("available stays available when the next check is offline", async () => {
    const ctx = await available();
    ctx.respondWith(() => {
      throw new TypeError("Failed to fetch");
    });
    const state = await ctx.service.check();
    expect(state).toMatchObject({
      status: "available",
      checkedAt: NOW,
      latest: { version: "1.0.1" },
      lastCheckFailed: { error: "offline", at: NOW + 60 * MIN },
    });
  });

  it("available stays available through a rate limit", async () => {
    const ctx = await available();
    ctx.respondWith(() => json({}, 403, { "x-ratelimit-remaining": "0" }));
    expect(await ctx.service.check()).toMatchObject({
      status: "available",
      lastCheckFailed: { error: "rate_limited" },
    });
  });

  it("available becomes an error when the release is gone", async () => {
    const ctx = await available();
    ctx.respondWith(() => json({ message: "Not Found" }, 404));
    const state = await ctx.service.check();
    expect(state).toMatchObject({ status: "error", error: "no_release" });
    expect(state.latest).toBeUndefined();
    expect(state.lastCheckFailed).toBeUndefined();
  });

  it("available becomes idle when the latest release is no longer newer", async () => {
    const ctx = await available();
    ctx.respondWith(() => json(release("1.0.0")));
    const state = await ctx.service.check();
    expect(state.status).toBe("idle");
    expect(state.latest).toBeUndefined();
  });

  it("a later success drops lastCheckFailed", async () => {
    const ctx = await available();
    ctx.respondWith(() => {
      throw new TypeError("Failed to fetch");
    });
    await ctx.service.check();
    ctx.clock.t = NOW + 120 * MIN;
    ctx.respondWith(() => json(release("1.0.1")));
    const state = await ctx.service.check();
    expect(state.status).toBe("available");
    expect(state.lastCheckFailed).toBeUndefined();
    expect(state.checkedAt).toBe(NOW + 120 * MIN);
  });

  it("a stored available state of another running version is not kept", async () => {
    const { storage } = memory();
    const old = new UpdateService(
      { fetch: async () => json(release("1.0.1")) },
      storage,
      RELEASES_URL,
      () => "1.0.0",
      () => NOW,
    );
    await old.check();
    const offline = new UpdateService(
      {
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
      storage,
      RELEASES_URL,
      () => "1.0.1",
      () => NOW + 60 * MIN,
    );
    expect(await offline.check()).toMatchObject({ status: "error", error: "offline" });
  });
});

describe("UpdateService throttling", () => {
  it("an automatic check within 30 minutes of the last attempt does not fetch", async () => {
    const ctx = setup(() => json(release("1.0.1")));
    await ctx.service.check();
    ctx.clock.t = NOW + 29 * MIN;
    const state = await ctx.service.check();
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("available");
  });

  it("an automatic check after 30 minutes fetches again", async () => {
    const ctx = setup(() => json(release("1.0.1")));
    await ctx.service.check();
    ctx.clock.t = NOW + 30 * MIN;
    await ctx.service.check();
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
  });

  it("a manual check within 60 seconds of the last attempt does not fetch", async () => {
    const ctx = setup(() => json(release("1.0.1")));
    await ctx.service.check();
    ctx.clock.t = NOW + 59_000;
    const state = await ctx.service.check({ manual: true });
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("available");
  });

  it("a manual check after 60 seconds fetches even inside the automatic window", async () => {
    const ctx = setup(() => json(release("1.0.1")));
    await ctx.service.check();
    ctx.clock.t = NOW + 61_000;
    await ctx.service.check({ manual: true });
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
  });

  it("the last attempt survives a service worker restart", async () => {
    const first = setup(() => json(release("1.0.1")));
    await first.service.check();
    const second = new UpdateService(
      { fetch: vi.fn() },
      first.storage,
      RELEASES_URL,
      () => "1.0.0",
      () => NOW + 5 * MIN,
    );
    expect((await second.check()).status).toBe("available");
  });

  it("a failed attempt also counts as an attempt", async () => {
    const ctx = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    await ctx.service.check();
    ctx.clock.t = NOW + 10 * MIN;
    await ctx.service.check();
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it("makes no request before the rate-limit reset, even for a manual check", async () => {
    const resetAt = NOW + 50 * MIN;
    const ctx = setup(() =>
      json({}, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(resetAt / 1000)),
      }),
    );
    await ctx.service.check();
    ctx.clock.t = NOW + 40 * MIN;
    const state = await ctx.service.check({ manual: true });
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ status: "error", error: "rate_limited" });
  });

  it("checks again once the rate-limit reset has passed", async () => {
    const resetAt = NOW + 50 * MIN;
    const ctx = setup(() =>
      json({}, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(resetAt / 1000)),
      }),
    );
    await ctx.service.check();
    ctx.respondWith(() => json(release("1.0.1")));
    ctx.clock.t = resetAt + 1000;
    expect((await ctx.service.check()).status).toBe("available");
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("update RPCs", () => {
  const state: UpdateState = { status: "idle", current: "1.0.0" };

  it("accepts the two request types", () => {
    expect(UiRequestSchema.safeParse({ type: "GET_UPDATE_STATE" }).success).toBe(true);
    expect(UiRequestSchema.safeParse({ type: "CHECK_FOR_UPDATE" }).success).toBe(true);
  });

  it("GET_UPDATE_STATE reads the stored state without checking", async () => {
    const getState = vi.fn(async () => state);
    const check = vi.fn(async () => state);
    stub.updates = { getState, check };
    expect(await handleUiRequest({ type: "GET_UPDATE_STATE" })).toEqual({ ok: true, data: state });
    expect(check).not.toHaveBeenCalled();
  });

  it("CHECK_FOR_UPDATE is a manual check and returns the fresh state", async () => {
    const fresh: UpdateState = { status: "error", current: "1.0.0", error: "offline" };
    const check = vi.fn(async (_opts?: { manual?: boolean }) => fresh);
    stub.updates = { getState: vi.fn(), check };
    expect(await handleUiRequest({ type: "CHECK_FOR_UPDATE" })).toEqual({ ok: true, data: fresh });
    expect(check).toHaveBeenCalledWith({ manual: true });
  });
});
