import { CURRENT_SESSION, type FbRecipe, type Group, type GroupCache } from "@nashir/shared";
import type { LoggerPort, StoragePort } from "./ports/index.js";
import type { GroupService } from "./GroupService.js";
import { GROUP_CACHE_TTL_MS, GROUP_RESUME_DELAY_MS } from "./GroupService.js";
import type { TokenScraper } from "./TokenScraper.js";
import type { CookieAccountManager } from "./CookieAccountManager.js";

/**
 * GroupSyncService — the one place that decides WHEN to go and fetch groups.
 *
 * Two paths, deliberately different in how much they are allowed to disturb:
 *
 *  - `syncIfStale` is the automatic one. It runs the moment the extension can get
 *    session tokens for free (a facebook.com tab is already open and logged in) and
 *    the cache has aged out. It never opens a tab and never swaps cookies, so the
 *    user notices nothing; if the preconditions do not hold it simply does nothing.
 *  - `load` is the user-initiated one, invoked from the Groups page. It may open a
 *    background tab, and for a managed account it swaps cookies to that account first.
 *
 * A single in-flight promise per account collapses concurrent callers — the dashboard
 * mounting while a tab finishes loading would otherwise fire two identical fetches.
 */
/**
 * Floor between two automatic attempts for the same account, after a success.
 *
 * This used to live in an in-memory Map, which meant it did not exist. MV3 evicts the
 * service worker after ~30 seconds idle and `chrome.tabs.onUpdated` fires a sync on
 * every facebook.com page load, so each attempt woke a fresh service worker holding an empty
 * Map and the floor never applied. Combined with a cache that could not become fresh,
 * that turned ordinary browsing into a paginated Facebook request burst every couple
 * of minutes — the traffic that earned the "too many calls from this app" block.
 *
 * It is persisted now. Anything that governs Facebook traffic must survive eviction or
 * it is decoration.
 */
const AUTO_SYNC_RETRY_FLOOR_MS = 5 * 60 * 1000;

/**
 * And a much longer floor after a failure. A sync that fails once (rotated doc_id,
 * expired token) will almost certainly fail again; retrying it eagerly spends the call
 * budget on a call we already know the answer to.
 */
const AUTO_SYNC_FAILURE_FLOOR_MS = 30 * 60 * 1000;

const attemptKey = (accountId: string) => `nashir:groupsync:attempt:${accountId}`;

/** Alarm that runs the next batch of an unfinished joined-groups walk. */
export const ALARM_GROUPS_RESUME = "nashir:groups-resume";

interface AttemptRecord {
  at: number;
  ok: boolean;
}

export class GroupSyncService {
  private inFlight = new Map<string, Promise<Group[]>>();

  constructor(
    private readonly groups: GroupService,
    private readonly scraper: TokenScraper,
    private readonly accounts: CookieAccountManager,
    private readonly getRecipe: () => Promise<FbRecipe>,
    private readonly logger: LoggerPort,
    private readonly storage: StoragePort,
    /**
     * A campaign owns the call budget while it runs. Background refreshes wait — a
     * group list six hours old is not worth a post being throttled over.
     */
    private readonly isRunActive: () => Promise<boolean> = async () => false,
    /**
     * Wakes the service worker later to run the next batch of an unfinished walk. Alarm-backed,
     * because a setTimeout dies with the service worker long before two minutes pass.
     */
    private readonly scheduleResume: (atEpochMs: number) => Promise<void> = async () => {},
  ) {}

  /**
   * Refresh the current session's groups if the cache is stale and tokens are free to
   * get. Returns the cache either way, or null when nothing could be determined.
   */
  async syncIfStale(
    accountId: string = CURRENT_SESSION,
    ttlMs: number = GROUP_CACHE_TTL_MS,
  ): Promise<GroupCache | null> {
    // Managed accounts would need a cookie swap, which is never acceptable in the
    // background — the user could be mid-session in another tab.
    if (accountId !== CURRENT_SESSION) return this.groups.getCache(accountId);

    const now = Date.now();
    // An unfinished walk is due regardless of how fresh `syncedAt` looks: the cache was
    // just written by the batch before, and waiting six hours would leave the list short.
    const resuming = await this.groups.hasPendingWalk(accountId, now);
    if (!resuming && !(await this.groups.isStale(accountId, now, ttlMs))) {
      return this.groups.getCache(accountId);
    }
    if (await this.isRunActive()) {
      this.logger.info("Group auto-sync deferred — a campaign is running");
      if (resuming) await this.scheduleNextBatch();
      return this.groups.getCache(accountId);
    }

    const last = await this.storage.get<AttemptRecord>(attemptKey(accountId));
    if (last) {
      // The next batch of a walk only has to respect the gap between batches; a full
      // refresh keeps the longer floors.
      const floor = !last.ok
        ? AUTO_SYNC_FAILURE_FLOOR_MS
        : resuming
          ? GROUP_RESUME_DELAY_MS
          : AUTO_SYNC_RETRY_FLOOR_MS;
      if (now - last.at < floor) return this.groups.getCache(accountId);
    }
    // Written before the attempt, not after, so a crash mid-sync still counts as a try.
    await this.storage.set(attemptKey(accountId), { at: now, ok: false } satisfies AttemptRecord);

    const tokens = await this.scraper.scrapeFromOpenTab();
    if (!tokens) {
      this.logger.info("Group auto-sync skipped — no logged-in Facebook tab open");
      if (resuming) await this.scheduleNextBatch();
      return this.groups.getCache(accountId);
    }

    try {
      const recipe = await this.getRecipe();
      await this.dedupe(accountId, () =>
        this.groups.loadJoinedGroups(accountId, tokens, recipe, { refresh: true }),
      );
      await this.storage.set(attemptKey(accountId), {
        at: Date.now(),
        ok: true,
      } satisfies AttemptRecord);
      if (await this.groups.hasPendingWalk(accountId, Date.now())) await this.scheduleNextBatch();
    } catch (err) {
      this.logger.warn("Group auto-sync failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.groups.getCache(accountId);
  }

  /** User-initiated load. Opens a tab if needed, and swaps cookies for a managed account. */
  async load(accountId: string, refresh: boolean): Promise<Group[]> {
    const recipe = await this.getRecipe();

    if (accountId === CURRENT_SESSION) {
      const groups = await this.dedupe(accountId, async () => {
        const tokens = await this.scraper.scrapeCurrent();
        return this.groups.loadJoinedGroups(accountId, tokens, recipe, { refresh });
      });
      if (await this.groups.hasPendingWalk(accountId, Date.now())) await this.scheduleNextBatch();
      return groups;
    }

    // A managed account's next batch needs a cookie swap, which never happens in the
    // background — it continues the next time the user presses reload.
    return this.dedupe(accountId, () =>
      this.accounts.withAccount(accountId, async () => {
        const tokens = await this.scraper.scrapeAfterSwap();
        return this.groups.loadJoinedGroups(accountId, tokens, recipe, { refresh });
      }),
    );
  }

  private scheduleNextBatch(): Promise<void> {
    return this.scheduleResume(Date.now() + GROUP_RESUME_DELAY_MS);
  }

  private dedupe(accountId: string, work: () => Promise<Group[]>): Promise<Group[]> {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;
    const promise = work().finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, promise);
    return promise;
  }
}
