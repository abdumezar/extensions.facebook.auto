import { DEFAULT_FB_RECIPE, type FbRecipe, type SessionTokens } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { CommentService, findCommentId } from "./CommentService.js";
import type { HttpPort, LoggerPort } from "./ports/index.js";

const TOKENS = { av: "1", user: "1", cometReq: "15", fb_dtsg: "d", jazoest: "2", lsd: "l" } as SessionTokens;
const FEEDBACK = "1530000000000001";
const TARGET = btoa(`feedback:${FEEDBACK}`);
const POST_URL = "https://www.facebook.com/groups/1/posts/2/";

/** The recipe as it will look once a create-comment doc_id is captured. */
const RECIPE: FbRecipe = {
  ...DEFAULT_FB_RECIPE,
  createComment: { docId: "555", friendlyName: "useCometUFICreateCommentMutation" },
};

const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const OK = { data: { comment_create: { feedback_comment_edge: { node: { __typename: "Comment", id: "c1" } } } } };

function harness(graphql: unknown, html = `<script>"${TARGET}"</script>`) {
  const calls: Array<{ url: string; friendly?: string; vars?: any }> = [];
  const http: HttpPort = {
    async fetch(url, init) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const friendly = headers["x-fb-friendly-name"];
      if (!friendly) {
        calls.push({ url });
        return new Response(html);
      }
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ url, friendly, vars: JSON.parse(body.get("variables") ?? "{}") });
      if (graphql instanceof Error) throw graphql;
      return new Response(JSON.stringify(graphql));
    },
  };
  return { svc: new CommentService(http, logger), calls };
}

describe("supported", () => {
  it("is false until a doc_id is captured", () => {
    const { svc } = harness(OK);
    expect(svc.supported(DEFAULT_FB_RECIPE)).toBe(false);
    expect(svc.supported(RECIPE)).toBe(true);
  });

  it("reports unsupported rather than failing", async () => {
    const { svc, calls } = harness(OK);
    const out = await svc.comment(POST_URL, "hi", TOKENS, DEFAULT_FB_RECIPE);
    expect(out.status).toBe("unsupported");
    expect(calls).toEqual([]);
  });
});

describe("comment", () => {
  it("resolves the permalink then posts to the feedback target", async () => {
    const { svc, calls } = harness(OK);
    const out = await svc.comment(POST_URL, "شكراً", TOKENS, RECIPE);
    expect(out).toMatchObject({ status: "posted", commentId: "c1" });
    // One page fetch to resolve, one mutation.
    expect(calls[0]?.url).toBe(POST_URL);
    expect(calls[1]?.vars.input.feedback_id).toBe(TARGET);
    expect(calls[1]?.vars.input.message.text).toBe("شكراً");
  });

  it("carries the friendly name so the governor bills it as a comment", async () => {
    const { svc, calls } = harness(OK);
    await svc.comment(POST_URL, "hi", TOKENS, RECIPE);
    expect(calls[1]?.friendly).toBe(RECIPE.createComment?.friendlyName);
  });

  it("refuses an empty body without touching Facebook", async () => {
    const { svc, calls } = harness(OK);
    expect(await svc.comment(POST_URL, "   ", TOKENS, RECIPE)).toMatchObject({
      status: "failed",
      error: "empty_body",
    });
    expect(calls).toEqual([]);
  });

  it("fails cleanly when the permalink yields no feedback id", async () => {
    const { svc } = harness(OK, "<html>login</html>");
    expect(await svc.comment(POST_URL, "hi", TOKENS, RECIPE)).toMatchObject({
      status: "failed",
      error: "no_feedback_id",
    });
  });

  it("reports Facebook's own error text", async () => {
    const { svc } = harness({ errors: [{ message: "You can't comment right now" }] });
    const out = await svc.commentOnFeedback(FEEDBACK, "hi", TOKENS, RECIPE);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("can't comment");
  });

  it("does NOT call a silently-dropped comment a success", async () => {
    // Facebook answers 200 with a null payload when a comment is dropped — a blocked
    // link, a muted thread. Reporting that as posted tells the operator their link
    // went out when nobody will ever see it.
    const { svc } = harness({ data: { comment_create: null } });
    expect(await svc.commentOnFeedback(FEEDBACK, "hi", TOKENS, RECIPE)).toMatchObject({
      status: "failed",
      error: "no_comment_id_in_response",
    });
  });

  it("survives a transport failure", async () => {
    const { svc } = harness(new Error("ThrottledError: cooldown"));
    const out = await svc.commentOnFeedback(FEEDBACK, "hi", TOKENS, RECIPE);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("Throttled");
  });
});

describe("findCommentId", () => {
  it("finds the created comment however it is nested", () => {
    expect(findCommentId(OK)).toBe("c1");
    expect(findCommentId({ a: { b: [{ __typename: "Comment", legacy_fbid: "9" }] } })).toBe("9");
  });

  it("ignores nodes that are not comments", () => {
    expect(findCommentId({ __typename: "Story", id: "s1" })).toBeUndefined();
    expect(findCommentId(null)).toBeUndefined();
    expect(findCommentId({})).toBeUndefined();
  });
});
