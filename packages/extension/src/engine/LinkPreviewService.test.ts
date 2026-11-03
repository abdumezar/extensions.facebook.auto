import { describe, it, expect, vi } from "vitest";
import { DEFAULT_FB_RECIPE, type FbRecipe, type LinkPreview, type SessionTokens } from "@nashir/shared";
import { LinkPreviewService } from "./LinkPreviewService.js";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

const tokens: SessionTokens = {
  fb_dtsg: "dtsg_test_1234",
  jazoest: "2255",
  lsd: "lsd_test",
  user: "1",
  av: "1",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "1",
  scrapedAt: 0,
};

/** A recipe that DOES have a captured link-preview query. */
const withQuery: FbRecipe = {
  ...DEFAULT_FB_RECIPE,
  linkPreview: { docId: "123", friendlyName: "ComposerLinkPreviewQuery" },
};

function harness(body = "{}", ok = true) {
  const store = new Map<string, unknown>();
  const storage: StoragePort = {
    get: async <T,>(k: string) => (store.get(k) as T) ?? null,
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
  };
  const fetch = vi.fn<HttpPort["fetch"]>(async () => new Response(body, { status: ok ? 200 : 500 }));
  const http: HttpPort = { fetch };
  return { service: new LinkPreviewService(storage, http, noopLogger), fetch, store };
}

const URL = "https://example.com/offer";

describe("when no preview query has been captured", () => {
  it("reports unsupported without touching Facebook", async () => {
    const h = harness();
    const preview = await h.service.preview(URL, tokens, DEFAULT_FB_RECIPE);

    expect(preview.status).toBe("unsupported");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("still names the site, so the operator can tell two links apart", async () => {
    const h = harness();
    const preview = await h.service.preview(URL, tokens, DEFAULT_FB_RECIPE);
    expect(preview.siteName).toBe("example.com");
  });
});

describe("fetching a preview", () => {
  const card = JSON.stringify({
    data: {
      link_preview: {
        share: {
          title: "عرض خاص",
          description: "خصم 20% هذا الأسبوع",
          image: { uri: "https://scontent.example.com/pic.jpg" },
        },
      },
    },
  });

  it("finds the card fields wherever Facebook nests them", async () => {
    const preview = await harness(card).service.preview(URL, tokens, withQuery);

    expect(preview.status).toBe("ok");
    expect(preview.title).toBe("عرض خاص");
    expect(preview.description).toBe("خصم 20% هذا الأسبوع");
    expect(preview.imageUrl).toBe("https://scontent.example.com/pic.jpg");
  });

  it("sends the friendly name and doc id from the recipe, not hardcoded values", async () => {
    const h = harness(card);
    await h.service.preview(URL, tokens, withQuery);

    const [, init] = h.fetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["x-fb-friendly-name"]).toBe(
      "ComposerLinkPreviewQuery",
    );
    expect(String(init!.body)).toContain("doc_id=123");
  });

  it("strips Facebook's for(;;); prefix", async () => {
    const preview = await harness(`for (;;);${card}`).service.preview(URL, tokens, withQuery);
    expect(preview.status).toBe("ok");
  });

  it("reports 'empty' when Facebook has nothing to show for the link", async () => {
    const preview = await harness(JSON.stringify({ data: {} })).service.preview(URL, tokens, withQuery);
    expect(preview.status).toBe("empty");
  });

  it("reports 'failed' with Facebook's own words on a GraphQL error", async () => {
    const body = JSON.stringify({ errors: [{ message: "Cannot fetch link" }] });
    const preview = await harness(body).service.preview(URL, tokens, withQuery);

    expect(preview.status).toBe("failed");
    expect(preview.detail).toContain("Cannot fetch link");
  });

  it("reports 'failed' rather than throwing when the request itself dies", async () => {
    const storage: StoragePort = { get: async () => null, set: async () => {}, remove: async () => {} };
    const http: HttpPort = {
      fetch: async () => {
        throw new Error("network down");
      },
    };
    const preview = await new LinkPreviewService(storage, http, noopLogger).preview(
      URL,
      tokens,
      withQuery,
    );
    expect(preview).toMatchObject({ status: "failed", detail: "network down" });
  });
});

describe("caching", () => {
  const card = JSON.stringify({ data: { share: { title: "Cached" } } });

  it("serves a repeat ask from the cache", async () => {
    const h = harness(card);
    await h.service.preview(URL, tokens, withQuery);
    await h.service.preview(URL, tokens, withQuery);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the operator explicitly asks", async () => {
    const h = harness(card);
    await h.service.preview(URL, tokens, withQuery);
    await h.service.preview(URL, tokens, withQuery, true);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure — asking again should retry, not repeat the error", async () => {
    const h = harness(JSON.stringify({ errors: [{ message: "boom" }] }));
    await h.service.preview(URL, tokens, withQuery);
    await h.service.preview(URL, tokens, withQuery);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches once forgotten", async () => {
    const h = harness(card);
    await h.service.preview(URL, tokens, withQuery);
    await h.service.forget(URL);
    await h.service.preview(URL, tokens, withQuery);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("expires a stale preview", async () => {
    const h = harness(card);
    await h.service.preview(URL, tokens, withQuery);

    const key = [...h.store.keys()][0]!;
    const stale = h.store.get(key) as LinkPreview;
    h.store.set(key, { ...stale, fetchedAt: Date.now() - 48 * 3600_000 });

    await h.service.preview(URL, tokens, withQuery);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
