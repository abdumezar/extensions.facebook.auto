import { describe, it, expect, vi } from "vitest";
import {
  CURRENT_SESSION,
  DEFAULT_FB_RECIPE,
  type Campaign,
  type CampaignMedia,
  type SessionTokens,
} from "@nashir/shared";
import { CampaignEngine } from "./CampaignEngine.js";
import type { CampaignEngineDeps } from "./CampaignEngine.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { GroupService } from "./GroupService.js";
import type { AnalyticsStore } from "./AnalyticsStore.js";
import type { ImageUploadService } from "./ImageUploadService.js";
import type { VideoUploadService } from "./VideoUploadService.js";
import type { MediaStore } from "./MediaStore.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "./ports/index.js";
import { CallGovernor } from "./CallGovernor.js";
import { DEFAULT_CALL_BUDGET } from "./governorMath.js";

const tokens: SessionTokens = {
  fb_dtsg: "dtsg-token",
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

function media(blobId: string, kind: "image" | "video"): CampaignMedia {
  return { blobId, name: `${blobId}.bin`, mimeType: kind === "video" ? "video/mp4" : "image/jpeg", sizeBytes: 10, kind };
}

/**
 * Build an engine whose every dependency is a spy, plus the composer bodies it sent.
 * The FacebookClient is constructed inside the engine, so the only way to observe what
 * was actually posted is the HTTP body — which is also what Facebook sees.
 */
function harness(campaign: Campaign) {
  const storage = memStorage();
  const bodies: string[] = [];

  const http: HttpPort = {
    fetch: async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ data: { story_create: { story: { post_id: "9001" } } } }), {
        status: 200,
      });
    },
  };

  const clock: ClockPort = {
    now: () => 1_700_000_000_000,
    scheduleWake: vi.fn(async () => {}),
    clearWake: vi.fn(async () => {}),
  };

  const governor = new CallGovernor(storage, clock, noopLogger, DEFAULT_CALL_BUDGET, () => 0.5, async () => {});

  const imageUpload = vi.fn(async () => `photo_${imageUpload.mock.calls.length}`);
  const videoUpload = vi.fn(async () => `video_${videoUpload.mock.calls.length}`);

  const deps: CampaignEngineDeps = {
    storage,
    clock,
    logger: noopLogger,
    http,
    accounts: { listAccounts: async () => [] } as unknown as CookieAccountManager,
    scraper: { scrapeCurrent: async () => tokens } as unknown as TokenScraper,
    groups: { getGroups: async () => [{ id: "111111", name: "Test Group" }] } as unknown as GroupService,
    analytics: { record: async () => {} } as unknown as AnalyticsStore,
    images: { upload: imageUpload } as unknown as ImageUploadService,
    videos: { upload: videoUpload } as unknown as VideoUploadService,
    media: {
      get: async (id: string) => ({
        id,
        name: `${id}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 10,
        blob: new Blob(["x"]),
        kind: "image" as const,
        addedAt: 0,
      }),
    } as unknown as MediaStore,
    getRecipe: async () => DEFAULT_FB_RECIPE,
    governor,
  };

  const engine = new CampaignEngine(deps);
  const run = async () => {
    await storage.set(`nashir:campaign:${campaign.id}`, campaign);
    await engine.start(campaign);
    await engine.tick();
  };

  return { engine, run, bodies, imageUpload, videoUpload };
}

function campaignWith(attachments: CampaignMedia[]): Campaign {
  return {
    id: "c_1",
    name: "Campaign",
    accountIds: [CURRENT_SESSION],
    groupIds: ["111111"],
    variations: ["hello"],
    media: attachments,
    delay: { mode: "fixed", minSeconds: 60, maxSeconds: 60 },
    safetyBreak: { enabled: false, everyNPosts: 25, durationSeconds: 300 },
    antiDetection: {
      jitter: false,
      warmup: false,
      dailyBudgetPerAccount: 0,
      autoPauseAfterConsecutiveFailures: 3,
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The `variables` payload the engine posted, decoded from the form body. */
function composerVariables(body: string): any {
  return JSON.parse(new URLSearchParams(body).get("variables") ?? "{}");
}

describe("CampaignEngine media attachments", () => {
  it("uploads every image and attaches all of their ids to one post", async () => {
    const h = harness(campaignWith([media("a", "image"), media("b", "image"), media("c", "image")]));

    await h.run();

    expect(h.imageUpload).toHaveBeenCalledTimes(3);
    const attachments = composerVariables(h.bodies[0]!).input.attachments;
    expect(attachments).toEqual([
      { photo: { id: "photo_1" } },
      { photo: { id: "photo_2" } },
      { photo: { id: "photo_3" } },
    ]);
  });

  it("routes videos through the video pipeline and posts them alongside the photos", async () => {
    const h = harness(campaignWith([media("a", "image"), media("b", "video")]));

    await h.run();

    expect(h.imageUpload).toHaveBeenCalledTimes(1);
    expect(h.videoUpload).toHaveBeenCalledTimes(1);

    const attachments = composerVariables(h.bodies[0]!).input.attachments;
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toEqual({ photo: { id: "photo_1" } });
    expect(attachments[1].video.id).toBe("video_1");
  });

  it("preserves the order the user arranged the attachments in", async () => {
    const h = harness(campaignWith([media("z", "image"), media("y", "image")]));

    await h.run();

    expect(h.imageUpload.mock.calls.map((c) => (c as unknown as [Blob, string])[1])).toEqual([
      "z.bin",
      "y.bin",
    ]);
  });

  it("sends a plain text post when nothing is attached", async () => {
    const h = harness(campaignWith([]));

    await h.run();

    expect(h.imageUpload).not.toHaveBeenCalled();
    expect(composerVariables(h.bodies[0]!).input.attachments).toBeUndefined();
  });

  it("drops a link preview once media is attached, since the composer allows only one", async () => {
    const campaign = { ...campaignWith([media("a", "image")]), linkUrl: "https://example.com" };
    const h = harness(campaign);

    await h.run();

    const attachments = composerVariables(h.bodies[0]!).input.attachments;
    expect(attachments).toEqual([{ photo: { id: "photo_1" } }]);
  });
});
