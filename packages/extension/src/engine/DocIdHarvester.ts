import { DEFAULT_FB_RECIPE, bundledDocIds, recipeFriendlyNames, sanitizeHarvest } from "@nashir/shared";
import type { DocIdStore } from "./DocIdStore.js";
import { harvestLookup } from "./harvestLookup.js";
import type { LoggerPort, StoragePort } from "./ports/index.js";

const KEY = "nashir:docIdHarvest";
/** One look per tab per window: a Facebook tab fires `complete` on every navigation. */
export const HARVEST_INTERVAL_MS = 10 * 60_000;
const PRUNE_AFTER_MS = 60 * 60_000;

/** True for http(s) pages on facebook.com or one of its subdomains, judged on the host alone. */
export function isFacebookPage(url: string | undefined): boolean {
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return parsed.hostname === "facebook.com" || parsed.hostname.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

/**
 * Evaluates `func(...args)` in the page's own JavaScript world and returns its result.
 * The Chrome adapter lives in the container; the engine never touches `chrome`.
 */
export type ScriptRunner = (
  tabId: number,
  func: (names: string[]) => Record<string, string>,
  args: [string[]],
) => Promise<unknown>;

export type DocIdHarvesterDeps = {
  storage: StoragePort;
  store: DocIdStore;
  run: ScriptRunner;
  logger: LoggerPort;
  now?: () => number;
};

/**
 * Reads the doc_ids Facebook's own page is using, so a rotation does not break the
 * bundled recipe. Makes no request of its own: it only looks inside a tab the user
 * already has open.
 */
export class DocIdHarvester {
  /** Tabs being looked at right now; the persisted stamp lands after an await. */
  private readonly inFlight = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly deps: DocIdHarvesterDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Never rejects: it is fired from a tab listener with nobody to catch it. */
  async maybeHarvest(tabId: number): Promise<void> {
    if (this.inFlight.has(tabId)) return;
    this.inFlight.add(tabId);
    try {
      const now = this.now();
      // Persisted, because a service worker can be evicted between two page loads.
      const stamps = await this.readStamps(now);
      const last = stamps[String(tabId)];
      if (last !== undefined && now - last < HARVEST_INTERVAL_MS) return;
      // Stamped before the look, so a tab that cannot be scripted is not retried on
      // every navigation.
      stamps[String(tabId)] = now;
      await this.deps.storage.set(KEY, stamps);

      const recipe = DEFAULT_FB_RECIPE;
      let raw: unknown;
      try {
        raw = await this.deps.run(tabId, harvestLookup, [recipeFriendlyNames(recipe)]);
      } catch (err) {
        this.deps.logger.warn("doc_id harvest could not run", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const clean = sanitizeHarvest(raw, bundledDocIds(recipe));
      await this.deps.store.record(clean, now);
    } catch (err) {
      this.deps.logger.warn("doc_id harvest failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlight.delete(tabId);
    }
  }

  /** Last-look time per tab id, minus entries too old to matter. */
  private async readStamps(now: number): Promise<Record<string, number>> {
    const raw = await this.deps.storage.get<unknown>(KEY);
    const stamps: Record<string, number> = {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return stamps;
    for (const [id, at] of Object.entries(raw)) {
      if (typeof at === "number" && now - at <= PRUNE_AFTER_MS) stamps[id] = at;
    }
    return stamps;
  }
}
