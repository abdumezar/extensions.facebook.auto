import {
  DEFAULT_FB_RECIPE,
  bundledDocIds,
  type DocIdOverride,
  type DocIdOverrides,
  type FbRecipe,
} from "@nashir/shared";
import type { LoggerPort, StoragePort } from "./ports/index.js";

const KEY = "nashir:docIds";

export type DocIdChange = { name: string; from: string; to: string };

export type DocIdRow = {
  name: string;
  active: string;
  source: "bundled" | "learned";
  seenAt?: number;
};

function isOverride(value: unknown): value is DocIdOverride {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.docId === "string" &&
    typeof v.bundledAtLearn === "string" &&
    typeof v.seenAt === "number"
  );
}

/**
 * The doc_ids this install has seen Facebook use, kept apart from the bundled recipe.
 *
 * An override remembers which bundled id it replaced. When the extension is updated
 * and the bundle moves on, overrides learned against the old bundle stop applying.
 */
export class DocIdStore {
  private readonly bundled: Record<string, string>;

  constructor(
    private readonly storage: StoragePort,
    private readonly logger: LoggerPort,
    bundle: FbRecipe = DEFAULT_FB_RECIPE,
  ) {
    this.bundled = bundledDocIds(bundle);
  }

  /** What is stored, including entries a newer bundle has already outdated. */
  private async readAll(): Promise<DocIdOverrides> {
    const raw = await this.storage.get<unknown>(KEY);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: DocIdOverrides = {};
    for (const [name, value] of Object.entries(raw)) {
      if (isOverride(value)) out[name] = value;
    }
    return out;
  }

  /** The overrides that still apply to the bundled recipe. */
  async get(): Promise<DocIdOverrides> {
    const all = await this.readAll();
    const live: DocIdOverrides = {};
    for (const [name, override] of Object.entries(all)) {
      if (Object.prototype.hasOwnProperty.call(this.bundled, name) && override.bundledAtLearn === this.bundled[name]) {
        live[name] = override;
      }
    }
    return live;
  }

  /**
   * Fold what a page showed us into the store. An id equal to the bundled one clears
   * the override; a different one replaces it. Returns the operations whose active id
   * actually changed.
   */
  async record(ids: Record<string, string>, now: number): Promise<DocIdChange[]> {
    const current = await this.get();
    const next: DocIdOverrides = { ...current };
    const changes: DocIdChange[] = [];
    let dirty = false;

    for (const [name, docId] of Object.entries(ids)) {
      if (!Object.prototype.hasOwnProperty.call(this.bundled, name)) continue;
      const bundled = this.bundled[name]!;
      const before = current[name]?.docId ?? bundled;

      if (docId === bundled) {
        if (name in next) {
          delete next[name];
          dirty = true;
        }
      } else {
        next[name] = { docId, seenAt: now, bundledAtLearn: bundled };
        dirty = true;
      }

      if (before !== docId) {
        changes.push({ name, from: before, to: docId });
        this.logger.info(`doc_id changed for ${name}`, { from: before, to: docId });
      }
    }

    if (dirty) await this.storage.set(KEY, next);
    return changes;
  }

  /** Every operation in the bundle, with the id in force and where it came from. */
  async list(): Promise<DocIdRow[]> {
    const overrides = await this.get();
    return Object.entries(this.bundled).map(([name, bundled]) => {
      const override = overrides[name];
      return override
        ? { name, active: override.docId, source: "learned", seenAt: override.seenAt }
        : { name, active: bundled, source: "bundled" };
    });
  }
}
