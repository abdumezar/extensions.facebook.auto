import { describe, it, expect } from "vitest";
import { FacebookClient } from "./FacebookClient.js";
import { DEFAULT_FB_RECIPE, type SessionTokens } from "@nashir/shared";
import type { HttpPort, LoggerPort } from "./ports/index.js";

const tokens: SessionTokens = {
  fb_dtsg: "dtsg_test_1234",
  jazoest: "2255",
  lsd: "lsd_test",
  user: "100000000000001",
  av: "100000000000001",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "1",
  scrapedAt: Date.now(),
};

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

/** HttpPort that returns a canned FB response body. */
function fakeHttp(body: string, ok = true): HttpPort {
  return {
    fetch: async () =>
      new Response(body, { status: ok ? 200 : 500, headers: { "content-type": "application/json" } }),
  };
}

function client(body: string, ok = true) {
  return new FacebookClient(fakeHttp(body, ok), tokens, DEFAULT_FB_RECIPE, noopLogger);
}

const input = {
  groupId: "123",
  message: "hello",
  composerSessionId: "sess_1",
};

describe("FacebookClient.createGroupPost classification", () => {
  it("REGRESSION: a real post id with a benign 'pending_stories' field is PUBLISHED, not pending", async () => {
    // This is the shape that caused the first-attempt false 'pending approval' for group admins.
    const body = JSON.stringify({
      data: {
        story_create: {
          story: { id: "Uzpf_STORY_1", post_id: "998877" },
          group: { pending_stories: { count: 0 }, can_viewer_approve_pending_stories: true },
        },
      },
    });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("published");
    expect(res.postId).toBe("998877");
  });

  it("classifies an EXPLICIT is_pending flag as pending_approval", async () => {
    const body = JSON.stringify({
      data: { story_create: { story: { id: "Uzpf_STORY_2", is_pending: true } } },
    });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("pending_approval");
  });

  it("classifies approval_status=PENDING as pending_approval", async () => {
    const body = JSON.stringify({
      data: { story_create: { story: { id: "s3", approval_status: "PENDING" } } },
    });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("pending_approval");
  });

  it("an errors[] response mentioning approval is pending_approval", async () => {
    const body = JSON.stringify({ errors: [{ message: "Your post is pending approval by an admin" }] });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("pending_approval");
  });

  it("a generic error is failed", async () => {
    const body = JSON.stringify({ errors: [{ message: "Something went wrong (1357004)" }] });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("failed");
  });

  it("a clean success with a story id is published", async () => {
    const body = JSON.stringify({ data: { story_create: { story: { id: "s5", post_id: "555" } } } });
    const res = await client(body).createGroupPost(input);
    expect(res.status).toBe("published");
    expect(res.permalink).toContain("555");
  });
});
