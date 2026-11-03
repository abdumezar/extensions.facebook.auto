import {
  CURRENT_SESSION,
  DEFAULT_FB_RECIPE,
  type Campaign,
  type SessionTokens,
} from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { CallGovernor } from "./CallGovernor.js";
import { CampaignEngine, type CampaignEngineDeps } from "./CampaignEngine.js";
import type { CommentService } from "./CommentService.js";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { GroupService } from "./GroupService.js";
import type { ImageUploadService } from "./ImageUploadService.js";
import type { MediaStore } from "./MediaStore.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { VideoUploadService } from "./VideoUploadService.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";

const tokens: SessionTokens = {
  fb_dtsg: "d",
  jazoest: "2",
  lsd: "l",
  user: "1",
  av: "1",
  spinR: "1",
  spinB: "trunk",
  spinT: "1",
  cometReq: "1",
  scrapedAt: 0,
};

const noopLogger: LoggerPort = { info() {}, warn() {}, error() {} };

function memStorage(): StoragePort {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

/** Whatever the composer answers decides whether a comment should follow. */
function harness(opts: {
  firstComment?: string;
  /** Facebook's answer to the post. Default: it published, with an id. */
  postResponse?: unknown;
  /** No open Facebook tab, so no tokens for the comment. */
  noTokens?: boolean;
  commentThrows?: boolean;
}) {
  const storage = memStorage();
  const clock: ClockPort = {
    now: () => 1_700_000_000_000,
    scheduleWake: vi.fn(async () => {}),
    clearWake: vi.fn(async () => {}),
  };
  const http: HttpPort = {
    fetch: async () =>
      new Response(
        JSON.stringify(
          opts.postResponse ?? { data: { story_create: { story: { post_id: "9001" } } } },
        ),
        { status: 200 },
      ),
  };
  const governor = new CallGovernor(storage, clock, noopLogger, DEFAULT_CALL_BUDGET, () => 0.5, async () => {});

  const comment = vi.fn(async (_postUrl: string, _body: string, ..._rest: unknown[]) => {
    if (opts.commentThrows) throw new Error("ThrottledError: cooldown");
    return { status: "posted" as const, commentId: "c1" };
  });

  const campaign: Campaign = {
    id: "c_1",
    name: "Campaign",
    accountIds: [CURRENT_SESSION],
    groupIds: ["111111"],
    variations: ["hello"],
    delay: { mode: "fixed", minSeconds: 60, maxSeconds: 60 },
    safetyBreak: { enabled: false, everyNPosts: 25, durationSeconds: 300 },
    antiDetection: {
      jitter: false,
      warmup: false,
      dailyBudgetPerAccount: 0,
      autoPauseAfterConsecutiveFailures: 3,
    },
    ...(opts.firstComment !== undefined ? { firstComment: opts.firstComment } : {}),
    createdAt: 0,
    updatedAt: 0,
  };

  const deps: CampaignEngineDeps = {
    storage,
    clock,
    logger: noopLogger,
    http,
    accounts: { listAccounts: async () => [] } as unknown as CookieAccountManager,
    scraper: {
      scrapeCurrent: async () => tokens,
      scrapeFromOpenTab: async () => (opts.noTokens ? null : tokens),
    } as unknown as TokenScraper,
    groups: { getGroups: async () => [{ id: "111111", name: "Test Group" }] } as unknown as GroupService,
    analytics: { record: async () => {} } as unknown as AnalyticsStore,
    images: { upload: vi.fn() } as unknown as ImageUploadService,
    videos: { upload: vi.fn() } as unknown as VideoUploadService,
    media: {} as unknown as MediaStore,
    comments: { comment } as unknown as CommentService,
    getRecipe: async () => DEFAULT_FB_RECIPE,
    governor,
  };

  const engine = new CampaignEngine(deps);
  return {
    comment,
    run: async () => {
      await storage.set(`nashir:campaign:${campaign.id}`, campaign);
      await engine.start(campaign);
      await engine.tick();
    },
  };
}

describe("CampaignEngine first comment", () => {
  it("posts it after a post that published", async () => {
    const h = harness({ firstComment: "للتواصل: 0551234567" });
    await h.run();
    expect(h.comment).toHaveBeenCalledTimes(1);
    expect(h.comment.mock.calls[0]?.[1]).toBe("للتواصل: 0551234567");
  });

  it("does nothing when the campaign has no first comment", async () => {
    await harness({}).run();
    const h = harness({ firstComment: "   " });
    await h.run();
    expect(h.comment).not.toHaveBeenCalled();
  });

  it("skips a post that is only pending admin approval", async () => {
    // Nothing is visible yet, so there is nowhere to put the comment and the call
    // would be spent on nothing.
    const h = harness({
      firstComment: "hi",
      postResponse: { data: { story_create: null }, errors: [{ message: "pending approval" }] },
    });
    await h.run();
    expect(h.comment).not.toHaveBeenCalled();
  });

  it("skips when there is no open Facebook tab to read tokens from", async () => {
    const h = harness({ firstComment: "hi", noTokens: true });
    await h.run();
    expect(h.comment).not.toHaveBeenCalled();
  });

  it("never lets a failed comment fail the post", async () => {
    // The post already succeeded and cannot be un-sent; a throw here would mark a
    // landed post as failed and re-queue it, posting it twice.
    const h = harness({ firstComment: "hi", commentThrows: true });
    await expect(h.run()).resolves.not.toThrow();
    expect(h.comment).toHaveBeenCalledTimes(1);
  });
});
