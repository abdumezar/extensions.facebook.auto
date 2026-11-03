import { DEFAULT_FB_RECIPE, type FbRecipe } from "@nashir/shared";
import { ChromeStorage } from "../platform/ChromeStorage.js";
import { ChromeCookies } from "../platform/ChromeCookies.js";
import { ChromeAlarms } from "../platform/ChromeAlarms.js";
import { ChromeTabs } from "../platform/ChromeTabs.js";
import { ChromeHttp } from "../platform/ChromeHttp.js";
import { WebCryptoSealer } from "../platform/WebCryptoSealer.js";
import { RingLogger } from "../platform/RingLogger.js";
import { CookieAccountManager } from "../engine/CookieAccountManager.js";
import { CallGovernor } from "../engine/CallGovernor.js";
import { GovernedHttp } from "../engine/GovernedHttp.js";
import { TokenScraper } from "../engine/TokenScraper.js";
import { GroupService } from "../engine/GroupService.js";
import { ALARM_GROUPS_RESUME, GroupSyncService } from "../engine/GroupSyncService.js";
import { GroupLeaveService } from "../engine/GroupLeaveService.js";
import { SessionProbe } from "../engine/SessionProbe.js";
import { AnalyticsStore } from "../engine/AnalyticsStore.js";
import { AudienceStore } from "../engine/AudienceStore.js";
import { AudienceService } from "../engine/AudienceService.js";
import { EngagementService } from "../engine/EngagementService.js";
import { LeadRadarService } from "../engine/LeadRadarService.js";
import { CommentService } from "../engine/CommentService.js";
import { GroupJoinService } from "../engine/GroupJoinService.js";
import { ImageUploadService } from "../engine/ImageUploadService.js";
import { VideoUploadService } from "../engine/VideoUploadService.js";
import { MediaStore } from "../engine/MediaStore.js";
import { CampaignEngine } from "../engine/CampaignEngine.js";
import { FeasibilityRunner } from "../engine/FeasibilityRunner.js";
import { LinkPreviewService } from "../engine/LinkPreviewService.js";

/**
 * Composition root. Builds every engine module from platform adapters exactly once.
 * The engine itself never sees chrome.* — only these adapters do.
 */
export class Container {
  readonly storage = new ChromeStorage();
  readonly cookies = new ChromeCookies();
  readonly clock = new ChromeAlarms();
  readonly tab = new ChromeTabs();
  readonly logger = new RingLogger(this.storage);
  readonly crypto = new WebCryptoSealer(this.storage);

  readonly accounts = new CookieAccountManager(
    this.cookies,
    this.storage,
    this.crypto,
    this.tab,
    this.logger,
    // Lazy on purpose: `governor` is declared below, and a class field cannot forward-
    // reference one. The scrape happens long after construction, so this is safe.
    { acquire: (d, c, a) => this.governor.acquire(d, c, a) },
  );

  /**
   * Every Facebook request goes through the governor; nothing else does.
   *
   * `http` is deliberately the governed instance, not the raw one, so no consumer can
   * opt out by accident — Facebook counts calls per caller, and one unpaced subsystem
   * is enough to earn a block for all of them.
   */
  readonly rawHttp = new ChromeHttp();
  readonly governor = new CallGovernor(this.storage, this.clock, this.logger);
  readonly http = new GovernedHttp(
    this.rawHttp,
    this.governor,
    () => this.getRecipe(),
    this.logger,
    () => this.accounts.activeAccountId() ?? undefined,
  );
  readonly scraper = new TokenScraper(this.tab, this.logger, this.governor);
  readonly session = new SessionProbe(
    this.cookies,
    this.tab,
    this.scraper,
    this.logger,
    // Gives the probe a memory, so the connection card names the account on a cold
    // open instead of showing a numeric id until the user opens Facebook.
    this.storage,
  );
  readonly groups = new GroupService(this.storage, this.http, this.logger);
  readonly groupSync = new GroupSyncService(
    this.groups,
    this.scraper,
    this.accounts,
    () => this.getRecipe(),
    this.logger,
    this.storage,
    // Lazy: `engine` is built further down, and a background refresh must never
    // compete with a live campaign for Facebook's call budget.
    async () => {
      const state = await this.engine.getState();
      return state?.status === "running" || state?.status === "safety_break";
    },
    (at) => this.clock.scheduleWake(ALARM_GROUPS_RESUME, at),
  );
  readonly groupLeave = new GroupLeaveService(
    this.groups,
    this.http,
    this.logger,
    undefined,
    undefined,
    this.governor,
  );
  readonly analytics = new AnalyticsStore();
  readonly media = new MediaStore();
  /**
   * The extracted people. Local-only by construction: `AudienceService` is handed the
   * store and the governed http, and nothing here sends it anywhere else.
   */
  readonly audienceStore = new AudienceStore();
  readonly audience = new AudienceService(
    this.audienceStore,
    this.storage,
    // The governed instance, like every other Facebook consumer. An audience walk is
    // the most paginating thing in the product; ungoverned it would be the fastest
    // way back to a block.
    this.http,
    this.logger,
  );
  /**
   * Reads our own landed posts back, so Analytics can answer "did it work" and not
   * only "did it send". Reuses `audience` wholesale — no new recipe entry, no new
   * endpoint class — and runs on its own slow alarm, off by default.
   */
  readonly engagement = new EngagementService(
    this.analytics,
    this.audience,
    this.storage,
    this.clock,
    this.logger,
  );

  /**
   * Watches joined groups for someone trying to buy. The only *recurring unattended*
   * Facebook traffic in the product, which is why it has its own slow endpoint class
   * and its own alarm rather than riding the campaign loop.
   */
  readonly radar = new LeadRadarService({
    storage: this.storage,
    http: this.http,
    clock: this.clock,
    logger: this.logger,
    audience: this.audienceStore,
    notify: async (title, message, id) => {
      // `notifications` has been requested since the manifest was written and never
      // used. This is what it was for.
      await chrome.notifications.create(`nashir:lead:${id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("src/assets/icons/icon-128.png"),
        title,
        message,
      });
    },
  });

  readonly comments = new CommentService(this.http, this.logger);
  readonly joins = new GroupJoinService(this.storage, this.http, this.logger);

  readonly links = new LinkPreviewService(this.storage, this.http, this.logger);
  readonly images = new ImageUploadService(this.http, this.logger);
  readonly videos = new VideoUploadService(this.http, this.logger);

  readonly engine = new CampaignEngine({
    storage: this.storage,
    clock: this.clock,
    logger: this.logger,
    http: this.http,
    accounts: this.accounts,
    scraper: this.scraper,
    groups: this.groups,
    analytics: this.analytics,
    images: this.images,
    videos: this.videos,
    media: this.media,
    comments: this.comments,
    getRecipe: () => this.getRecipe(),
    governor: this.governor,
  });

  readonly feasibility = new FeasibilityRunner({
    storage: this.storage,
    clock: this.clock,
    cookies: this.cookies,
    http: this.http,
    logger: this.logger,
    accounts: this.accounts,
    scraper: this.scraper,
    session: this.session,
    getRecipe: () => this.getRecipe(),
    governor: this.governor,
    // The two capabilities that genuinely need Chrome, injected so the runner itself
    // stays as port-only and testable as the rest of the engine.
    countFbTabs: async () => (await chrome.tabs.query({ url: "*://*.facebook.com/*" })).length,
    dnrSummary: async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const headers = rules[0]?.action.requestHeaders ?? [];
      return {
        ruleCount: rules.length,
        origin: headers.find((h) => h.header === "origin")?.value,
        referer: headers.find((h) => h.header === "referer")?.value,
      };
    },
  });

  /** The recipe to post with. */
  getRecipe(): Promise<FbRecipe> {
    return Promise.resolve(DEFAULT_FB_RECIPE);
  }
}

let instance: Container | null = null;
export function container(): Container {
  if (!instance) instance = new Container();
  return instance;
}
