import { DEFAULT_FB_RECIPE, type AudienceSighting, type Contact, type SessionTokens } from "@nashir/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudienceService,
  MAX_AUDIENCE_PAGES,
  REACTOR_PAGE_SIZE,
  isFacebookUrl,
} from "./AudienceService.js";
import type { AudienceStore } from "./AudienceStore.js";
import fixtures from "./__fixtures__/audience.json";
import type { HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const f = fixtures as Record<string, any>;
const FEEDBACK = "1530000000000001";
const TARGET = btoa(`feedback:${FEEDBACK}`);
const POST_URL = "https://www.facebook.com/groups/123456/posts/987654/";

const TOKENS: SessionTokens = {
  fb_dtsg: "dtsg",
  jazoest: "2999",
  lsd: "lsd",
  user: "1",
  av: "1",
  spinR: "r",
  spinB: "b",
  spinT: "t",
  cometReq: "15",
  scrapedAt: 0,
};

/** Records what was written, without an IndexedDB. */
function fakeStore() {
  const rows = new Map<string, { name: string; sightings: AudienceSighting[]; contacts: Contact[] }>();
  const store = {
    async upsert(person: any, sighting: AudienceSighting, contacts: Contact[]) {
      const existing = rows.get(person.id);
      const hadContact = (existing?.contacts.length ?? 0) > 0;
      const merged = [...(existing?.contacts ?? []), ...contacts];
      rows.set(person.id, {
        name: person.name,
        sightings: [...(existing?.sightings ?? []), sighting],
        contacts: merged,
      });
      return { isNew: !existing, gainedContact: !hadContact && merged.length > 0 };
    },
  } as unknown as AudienceStore;
  return { store, rows };
}

function fakeStorage() {
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
  return { storage, map };
}

const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** An HttpPort that answers by friendly name, recording every request. */
function fakeHttp(handlers: {
  html?: string;
  onGraphql?: (friendly: string, vars: any, callIndex: number) => unknown;
}) {
  const calls: Array<{ url: string; friendly?: string; vars?: any; headers: any }> = [];
  let n = 0;
  const http: HttpPort = {
    async fetch(input, init) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const friendly = headers["x-fb-friendly-name"];
      if (!friendly) {
        calls.push({ url: input, headers });
        return new Response(handlers.html ?? "", { status: 200 });
      }
      const body = new URLSearchParams(String(init?.body ?? ""));
      const vars = JSON.parse(body.get("variables") ?? "{}");
      calls.push({ url: input, friendly, vars, headers });
      const out = handlers.onGraphql?.(friendly, vars, n++) ?? { data: {} };
      return new Response(JSON.stringify(out), { status: 200 });
    },
  };
  return { http, calls };
}

const R = DEFAULT_FB_RECIPE;
const HTML_WITH_ID = `<html><script>{"t":"${TARGET}"}</script></html>`;

describe("resolvePost", () => {
  it("reads the feedback id out of the permalink page", async () => {
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http } = fakeHttp({ html: HTML_WITH_ID });
    const svc = new AudienceService(store, storage, http, logger);
    await expect(svc.resolvePost(POST_URL, R)).resolves.toMatchObject({
      feedbackId: FEEDBACK,
      groupId: "123456",
      storyId: "987654",
    });
  });

  it("resolves a group reached by its vanity slug", async () => {
    // The shape that used to be rejected outright.
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http } = fakeHttp({ html: HTML_WITH_ID });
    const svc = new AudienceService(store, storage, http, logger);
    await expect(
      svc.resolvePost("https://www.facebook.com/groups/examplegroup/posts/1234567890123456", R),
    ).resolves.toMatchObject({ feedbackId: FEEDBACK, storyId: "1234567890123456" });
  });

  it("prefers the numeric group id from the page over the slug in the url", async () => {
    // So a group reached by slug and by id converge on one key in the store.
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http } = fakeHttp({ html: `${HTML_WITH_ID}<script>{"groupID":"778899001122"}</script>` });
    const svc = new AudienceService(store, storage, http, logger);
    const out = await svc.resolvePost(
      "https://www.facebook.com/groups/examplegroup/posts/123456",
      R,
    );
    expect(out.groupId).toBe("778899001122");
  });

  it("keeps the slug when the page does not name a numeric id", async () => {
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http } = fakeHttp({ html: HTML_WITH_ID });
    const svc = new AudienceService(store, storage, http, logger);
    const out = await svc.resolvePost(
      "https://www.facebook.com/groups/examplegroup/posts/123456",
      R,
    );
    expect(out.groupId).toBe("examplegroup");
  });

  it("refuses a non-Facebook host before making any credentialed request", async () => {
    // The recipe patterns are substring matches, so this URL parses as a post. Fetching
    // it with `credentials: "include"` is what the host check exists to prevent.
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http, calls } = fakeHttp({ html: HTML_WITH_ID });
    const svc = new AudienceService(store, storage, http, logger);
    expect(
      await svc.resolvePost("https://evil.example/?x=facebook.com/groups/a/posts/1", R),
    ).toEqual({ error: "not_a_post_url" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a url that is not a post, without fetching anything", async () => {
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http, calls } = fakeHttp({ html: HTML_WITH_ID });
    const svc = new AudienceService(store, storage, http, logger);
    expect(await svc.resolvePost("https://example.com/", R)).toEqual({ error: "not_a_post_url" });
    expect(calls).toHaveLength(0);
  });

  it("reports no_feedback_id when the page carries none", async () => {
    const { store } = fakeStore();
    const { storage } = fakeStorage();
    const { http } = fakeHttp({ html: "<html>please log in</html>" });
    const svc = new AudienceService(store, storage, http, logger);
    expect(await svc.resolvePost(POST_URL, R)).toMatchObject({ error: "no_feedback_id" });
  });
});

describe("extract", () => {
  let store: AudienceStore;
  let rows: ReturnType<typeof fakeStore>["rows"];
  let storage: StoragePort;

  beforeEach(() => {
    const s = fakeStore();
    store = s.store;
    rows = s.rows;
    storage = fakeStorage().storage;
  });

  const build = (onGraphql: Parameters<typeof fakeHttp>[0]["onGraphql"]) => {
    const { http, calls } = fakeHttp({ html: HTML_WITH_ID, onGraphql });
    // sleep stubbed: the pacing is asserted through the governor, not by waiting.
    const svc = new AudienceService(store, storage, http, logger, () => 1_700_000_000_000, async () => {});
    return { svc, calls };
  };

  it("reports unsupported when the recipe has no audience doc_ids", async () => {
    const { svc } = build(() => ({}));
    const bare = { ...R, postAudience: undefined };
    const state = await svc.extract(POST_URL, TOKENS, bare);
    expect(state.status).toBe("unsupported");
    expect(state.message).toBe("recipe_missing_post_audience");
  });

  it("walks reactors and commenters and writes both", async () => {
    const { svc, calls } = build((friendly) => {
      if (friendly.includes("Reactions")) return f["reactorsPage"];
      if (friendly === "CommentListComponentsRootQuery") return f["commentsFirstPage"];
      return f["commentsNextPage"];
    });
    const state = await svc.extract(POST_URL, TOKENS, R, { defaultRegion: "SA" });

    expect(state.status).toBe("done");
    expect(state.found).toBeGreaterThan(0);
    expect(rows.size).toBeGreaterThan(0);
    // Reactors carry a reaction, commenters carry text.
    const all = [...rows.values()].flatMap((r) => r.sightings);
    expect(all.some((s) => s.source === "post.reactor" && s.reaction === "Like")).toBe(true);
    expect(all.some((s) => s.source === "post.commenter" && (s.text ?? "").length > 0)).toBe(true);
    // Every GraphQL call must carry the friendly name, or the governor cannot bill it.
    for (const c of calls.filter((c) => c.friendly)) {
      expect(c.headers["x-fb-friendly-name"]).toBe(c.friendly);
    }
  });

  it("parses phone numbers out of comment text", async () => {
    const { svc } = build((friendly) =>
      friendly.includes("Reactions") ? { data: {} } : f["commentsFirstPage"],
    );
    await svc.extract(POST_URL, TOKENS, R, { defaultRegion: "SA", skipReactors: true });
    const found = [...rows.values()].flatMap((r) => r.contacts.map((c) => c.value));
    expect(found).toContain("+966501234567");
    expect(found).toContain("+971501234567");
  });

  it("asks for the All-reactions tab and a full page, keyed by the encoded feedback id", async () => {
    const { svc, calls } = build((friendly) =>
      friendly.includes("Reactions") ? { data: {} } : { data: {} },
    );
    await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    const first = calls.find((c) => c.friendly?.includes("Reactions"));
    expect(first?.vars).toMatchObject({
      count: REACTOR_PAGE_SIZE,
      cursor: null,
      reactionID: null,
      feedbackTargetID: TARGET,
      id: TARGET,
    });
  });

  it("sends the recipe's intent token and feed location on the first comment page", async () => {
    const { svc, calls } = build(() => f["commentsFirstPage"]);
    await svc.extract(POST_URL, TOKENS, R, { skipReactors: true });
    const first = calls.find((c) => c.friendly === "CommentListComponentsRootQuery");
    expect(first?.vars).toMatchObject({
      commentsIntentToken: R.postAudience?.commentsIntentToken,
      feedLocation: R.postAudience?.feedLocation,
      feedbackSource: R.postAudience?.feedbackSource,
      id: TARGET,
    });
    expect(first?.vars.__relay_internal__pv__IsWorkUserrelayprovider).toBe(false);
  });

  it("switches to the pagination query with a cursor after page one", async () => {
    let page = 0;
    const { svc, calls } = build((friendly) => {
      if (friendly.includes("Reactions")) return { data: {} };
      page++;
      // Page 1 says there is more; page 2 ends it.
      return page === 1 ? f["commentsFirstPage"] : f["commentsNextPage"];
    });
    await svc.extract(POST_URL, TOKENS, R, { skipReactors: true });
    const paged = calls.find((c) => c.friendly === "CommentsListComponentsPaginationQuery");
    expect(paged).toBeDefined();
    expect(paged?.vars.commentsAfterCursor).toBeTruthy();
    expect(paged?.vars.commentsAfterCount).toBe(-1);
  });

  it("stops when the cursor stops moving", async () => {
    // A connection that always claims another page with the same cursor would page
    // forever; the guard is what stops an infinite spend.
    const stuck = JSON.parse(JSON.stringify(f["reactorsPage"]));
    stuck.data.node.reactors.page_info = { has_next_page: true, end_cursor: "SAME" };
    const { svc, calls } = build((friendly) => (friendly.includes("Reactions") ? stuck : { data: {} }));
    const state = await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    expect(calls.filter((c) => c.friendly?.includes("Reactions")).length).toBe(2);
    expect(state.status).toBe("done");
  });

  it("caps the walk and marks the result truncated", async () => {
    let n = 0;
    const endless = () => {
      const copy = JSON.parse(JSON.stringify(f["reactorsPage"]));
      copy.data.node.reactors.page_info = { has_next_page: true, end_cursor: `c${n++}` };
      return copy;
    };
    const { svc, calls } = build((friendly) => (friendly.includes("Reactions") ? endless() : { data: {} }));
    const state = await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    expect(calls.filter((c) => c.friendly?.includes("Reactions")).length).toBe(MAX_AUDIENCE_PAGES);
    expect(state.truncated).toBe(true);
  });

  it("keeps the pages already fetched when the governor refuses mid-walk", async () => {
    let n = 0;
    const { svc } = build((friendly) => {
      if (!friendly.includes("Reactions")) return { data: {} };
      if (n++ >= 1) throw new Error("ThrottledError: cooldown");
      const copy = JSON.parse(JSON.stringify(f["reactorsPage"]));
      copy.data.node.reactors.page_info = { has_next_page: true, end_cursor: "next" };
      return copy;
    });
    const state = await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    expect(state.status).toBe("cooldown");
    expect(state.truncated).toBe(true);
    expect(rows.size).toBeGreaterThan(0);
  });

  it("aborts at the next page boundary", async () => {
    const { svc, calls } = build((friendly) => {
      if (!friendly.includes("Reactions")) return { data: {} };
      svc.abort();
      const copy = JSON.parse(JSON.stringify(f["reactorsPage"]));
      copy.data.node.reactors.page_info = { has_next_page: true, end_cursor: "next" };
      return copy;
    });
    const state = await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    expect(state.status).toBe("aborted");
    expect(calls.filter((c) => c.friendly?.includes("Reactions")).length).toBe(1);
  });

  it("persists state on every page so an eviction costs one page, not the run", async () => {
    const { svc } = build((friendly) => (friendly.includes("Reactions") ? f["reactorsPage"] : { data: {} }));
    await svc.extract(POST_URL, TOKENS, R, { skipComments: true });
    const saved = await svc.state();
    expect(saved?.feedbackId).toBe(FEEDBACK);
    expect(saved?.reactorPages).toBeGreaterThan(0);
    expect(saved?.postUrl).toBe(POST_URL);
  });

  it("records Facebook's own comment total", async () => {
    const { svc } = build(() => f["commentsFirstPage"]);
    const state = await svc.extract(POST_URL, TOKENS, R, { skipReactors: true });
    expect(state.totalComments).toBe(30);
  });

  it("errors cleanly when the post cannot be resolved", async () => {
    const { http } = fakeHttp({ html: "<html>nope</html>" });
    const svc = new AudienceService(store, storage, http, logger, () => 1, async () => {});
    const state = await svc.extract(POST_URL, TOKENS, R);
    expect(state.status).toBe("error");
    expect(state.message).toBe("no_feedback_id");
  });
});

describe("isFacebookUrl", () => {
  it("accepts the hosts Facebook actually serves from", () => {
    for (const u of [
      "https://facebook.com/x",
      "https://www.facebook.com/x",
      "https://m.facebook.com/x",
      "https://web.facebook.com/x",
      "https://upload.facebook.com/x",
    ]) {
      expect(isFacebookUrl(u)).toBe(true);
    }
  });

  it("rejects lookalikes, embeddings and non-http schemes", () => {
    for (const u of [
      "https://notfacebook.com/x",
      "https://facebook.com.evil.io/x",
      "https://evil.example/?x=facebook.com/groups/a/posts/1",
      "javascript:alert(1)",
      "data:text/html,facebook.com",
      "not a url",
    ]) {
      expect(isFacebookUrl(u)).toBe(false);
    }
  });
});
