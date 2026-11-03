import type { FbRecipe, LinkPreview, SessionTokens } from "@nashir/shared";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";
import { displayHost } from "./linkExtract.js";
import { parseFbJson } from "./fbResponse.js";

/**
 * LinkPreviewService — shows the operator what Facebook's link card will look like
 * before a campaign commits to it.
 *
 * The important thing to be clear about: this is NOT on the posting path. Attaching a
 * link needs only the URL, and Facebook builds the card server-side when the post goes
 * out. So every failure here degrades to "we could not show you a preview", never to
 * "the link will not attach".
 *
 * That is also why an uncaptured query is an honest `unsupported` rather than a guessed
 * doc_id: a wrong guess would fail at runtime looking exactly like Facebook breakage,
 * for a feature that is cosmetic.
 */

const CACHE_PREFIX = "nashir:linkpreview:";

/** Previews are metadata about someone else's page; a day is fresh enough. */
const TTL_MS = 24 * 60 * 60 * 1000;

export class LinkPreviewService {
  constructor(
    private readonly storage: StoragePort,
    private readonly http: HttpPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * @param force skip the cache — the operator explicitly asked to re-fetch, usually
   *   because the page it points at has changed since.
   */
  async preview(
    url: string,
    tokens: SessionTokens,
    recipe: FbRecipe,
    force = false,
  ): Promise<LinkPreview> {
    const key = CACHE_PREFIX + url;
    if (!force) {
      const cached = await this.storage.get<LinkPreview>(key);
      // Only successful previews are cached; re-asking after a failure should retry.
      if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
    }

    const query = recipe.linkPreview;
    if (!query) {
      return {
        url,
        status: "unsupported",
        siteName: displayHost(url),
        detail: "No link-preview query captured yet.",
        fetchedAt: Date.now(),
      };
    }

    try {
      const body = this.buildBody(url, tokens, query);
      const res = await this.http.fetch(recipe.endpoints.graphql, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": query.friendlyName,
        },
        body: body.toString(),
      });
      const text = await res.text();
      this.logger.info("FB link preview response", { httpOk: res.ok, snippet: text.slice(0, 300) });

      const parsed = this.parse(text);
      const preview: LinkPreview = {
        url,
        siteName: displayHost(url),
        fetchedAt: Date.now(),
        ...parsed,
      };
      if (preview.status === "ok") await this.storage.set(key, preview);
      return preview;
    } catch (err) {
      return {
        url,
        status: "failed",
        siteName: displayHost(url),
        detail: err instanceof Error ? err.message : String(err),
        fetchedAt: Date.now(),
      };
    }
  }

  /** Forget a cached preview, so the next ask re-fetches. */
  async forget(url: string): Promise<void> {
    await this.storage.remove(CACHE_PREFIX + url);
  }

  // ---- internals ----

  private buildBody(
    url: string,
    t: SessionTokens,
    query: NonNullable<FbRecipe["linkPreview"]>,
  ): URLSearchParams {
    const params = new URLSearchParams();
    params.set("av", t.av);
    params.set("__user", t.user);
    params.set("__a", "1");
    params.set("__comet_req", t.cometReq);
    params.set("fb_dtsg", t.fb_dtsg);
    params.set("jazoest", t.jazoest);
    params.set("lsd", t.lsd);
    params.set("__spin_r", t.spinR);
    params.set("__spin_b", t.spinB);
    params.set("__spin_t", t.spinT);
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", query.friendlyName);
    params.set("variables", JSON.stringify({ url, scale: 1 }));
    params.set("server_timestamps", "true");
    params.set("doc_id", query.docId);
    return params;
  }

  /**
   * Facebook nests link metadata differently depending on which composer surface asked,
   * so this walks for the fields rather than pinning one path — the same approach
   * `FacebookClient.extractPostId` takes, and for the same reason.
   */
  private parse(text: string): Pick<LinkPreview, "status" | "title" | "description" | "imageUrl" | "detail"> {
    const json = parseFbJson(text);
    if (json == null) return { status: "failed", detail: "Unparseable response" };

    const root = json as { errors?: { message?: string }[]; data?: unknown };
    if (Array.isArray(root.errors) && root.errors.length) {
      return { status: "failed", detail: root.errors.map((e) => e.message ?? "").join("; ") };
    }

    const title = findString(root.data, ["title", "share_title", "name"]);
    const description = findString(root.data, ["description", "share_description", "summary"]);
    const imageUrl = findString(root.data, ["uri", "image_uri", "url"], (v) => /^https?:\/\//.test(v));

    if (!title && !description && !imageUrl) {
      return { status: "empty", detail: "Facebook returned no card metadata for this link." };
    }
    return { status: "ok", title, description, imageUrl };
  }
}

/** First non-empty string under any of `keys`, searched breadth-first to a sane depth. */
function findString(
  node: unknown,
  keys: string[],
  accept: (value: string) => boolean = (v) => v.length > 0,
  depth = 0,
): string | undefined {
  if (!node || typeof node !== "object" || depth > 6) return undefined;
  const entries = Object.entries(node as Record<string, unknown>);

  for (const [k, v] of entries) {
    if (keys.includes(k) && typeof v === "string" && accept(v)) return v;
  }
  for (const [, v] of entries) {
    const nested = findString(v, keys, accept, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}
