import type { LatestRelease, UpdateError, UpdateState } from "@nashir/shared";
import type { HttpPort, StoragePort } from "../engine/ports/index.js";
import { isNewerVersion } from "./semver.js";

/** How often the service worker asks GitHub whether a newer release exists. */
export const ALARM_UPDATE_CHECK = "nashir:update-check";
export const UPDATE_CHECK_PERIOD_MINUTES = 360;

/** Fewest ms between two automatic checks, however they were triggered. */
export const AUTO_CHECK_MIN_GAP_MS = 30 * 60 * 1000;
/** Fewest ms between two checks the user asked for. */
export const MANUAL_CHECK_MIN_GAP_MS = 60 * 1000;
/** A request that has not finished by now is treated as offline. */
export const CHECK_TIMEOUT_MS = 15_000;
/** Longest a rate-limit reset time is believed; a bogus header must not mute checks for days. */
const MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 60 * 1000;

/** Where the last result is kept; pages listen for changes to it. */
export const UPDATE_STORAGE_KEY = "nashir:update";
const STORAGE_KEY = UPDATE_STORAGE_KEY;
const META_KEY = "nashir:update:meta";
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const GITHUB_API_HOST = "api.github.com";
const RELEASES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/;

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

/** Bookkeeping for throttling; kept apart from the state the UI reads. */
interface CheckMeta {
  lastAttemptAt: number;
  /** Do not ask again before this time (GitHub's rate-limit reset). */
  retryNotBefore?: number;
}

/**
 * Where a release's files may legitimately live, derived from the releases API URL the
 * service was configured with. Nothing the API response says about URLs is trusted.
 */
interface AssetOrigin {
  notesUrl(tag: string): string;
  isAssetUrl(url: string, tag: string, name: string): boolean;
}

/**
 * Production: the API URL names `<owner>/<repo>` on GitHub, and a release's files must
 * sit at exactly that repository's download path for the tag. Any other API origin (an
 * end-to-end test server) may serve its assets from that same origin only.
 */
function assetOriginFor(releasesApiUrl: string): AssetOrigin | null {
  let api: URL;
  try {
    api = new URL(releasesApiUrl);
  } catch {
    return null;
  }
  if (api.hostname === GITHUB_API_HOST) {
    const match = api.protocol === "https:" ? RELEASES_PATH.exec(api.pathname) : null;
    if (!match) return null;
    const repo = `https://github.com/${match[1]}/${match[2]}`;
    return {
      notesUrl: (tag) => `${repo}/releases/tag/${tag}`,
      isAssetUrl: (url, tag, name) => url === `${repo}/releases/download/${tag}/${name}`,
    };
  }
  return {
    notesUrl: (tag) => `${api.origin}/releases/tag/${tag}`,
    isAssetUrl: (url) => {
      try {
        return new URL(url).origin === api.origin;
      } catch {
        return false;
      }
    },
  };
}

type Outcome =
  | { kind: "state"; state: UpdateState }
  // No answer at all (as opposed to an answer of "no").
  | { kind: "transient"; error: UpdateError; retryNotBefore?: number };

type Reply = { res: Response; body: unknown } | { timedOut: true };

/**
 * Asks GitHub Releases whether a newer version exists and remembers the answer.
 *
 * It only ever *reports*: nothing here downloads or writes a release. It is handed the
 * plain http port on purpose, because the governed one is the Facebook call budget and
 * a request to GitHub has no business spending it.
 */
export class UpdateService {
  private inflight: Promise<UpdateState> | null = null;
  private readonly origin: AssetOrigin | null;

  constructor(
    private readonly http: HttpPort,
    private readonly storage: StoragePort,
    private readonly releasesApiUrl: string,
    private readonly currentVersion: () => string,
    private readonly now: () => number = Date.now,
  ) {
    this.origin = assetOriginFor(releasesApiUrl);
  }

  /** The last recorded result. Never touches the network. */
  async getState(): Promise<UpdateState> {
    const current = this.currentVersion();
    const stored = await this.storage.get<UpdateState>(STORAGE_KEY);
    // A result recorded by another version describes a release that may since have been
    // installed; showing "update available" for it would be wrong.
    return stored && stored.current === current ? stored : { status: "idle", current };
  }

  /**
   * Ask GitHub, record the answer and return it. Never throws.
   *
   * Checks are throttled: automatic ones (alarm, startup) wait 30 minutes after any
   * attempt, a manual one waits 60 seconds, and nothing asks again before a rate-limit
   * reset. A throttled call answers from the stored state.
   */
  check(opts: { manual?: boolean } = {}): Promise<UpdateState> {
    // The startup check and the alarm can land together; one request answers both.
    this.inflight ??= this.run(opts.manual === true).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(manual: boolean): Promise<UpdateState> {
    const at = this.now();
    const meta = await this.readMeta();
    if (meta?.retryNotBefore !== undefined && at < meta.retryNotBefore) return this.getState();
    const gap = manual ? MANUAL_CHECK_MIN_GAP_MS : AUTO_CHECK_MIN_GAP_MS;
    const since = meta ? at - meta.lastAttemptAt : Infinity;
    if (since >= 0 && since < gap) return this.getState();

    // Recorded before the request, so a service worker evicted mid-flight still counts it.
    await this.write(META_KEY, { lastAttemptAt: at } satisfies CheckMeta);

    const outcome = await this.fetchOutcome(at);
    let state: UpdateState;
    if (outcome.kind === "state") {
      state = outcome.state;
    } else {
      const stored = await this.getState();
      state =
        stored.status === "available"
          ? // The answer is unknown, not "no": keep offering what was last verified.
            { ...stored, lastCheckFailed: { error: outcome.error, at } }
          : { status: "error", current: stored.current, checkedAt: at, error: outcome.error };
      if (outcome.retryNotBefore !== undefined) {
        await this.write(META_KEY, {
          lastAttemptAt: at,
          retryNotBefore: outcome.retryNotBefore,
        } satisfies CheckMeta);
      }
    }
    await this.write(STORAGE_KEY, state);
    return state;
  }

  private async readMeta(): Promise<CheckMeta | null> {
    try {
      return await this.storage.get<CheckMeta>(META_KEY);
    } catch {
      return null;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch {
      // Remembering is a convenience; the answer itself is still good.
    }
  }

  /** One request with a deadline covering the headers and the body. Null on a network error. */
  private async request(): Promise<Reply | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Reply>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ timedOut: true });
      }, CHECK_TIMEOUT_MS);
    });
    const answer = (async (): Promise<Reply> => {
      const res = await this.http.fetch(this.releasesApiUrl, {
        headers: { Accept: "application/vnd.github+json" },
        // No cookies to GitHub, and never a cached answer to "is there a newer release".
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
      return { res, body };
    })();
    // If the deadline wins, the abandoned request may still reject later.
    answer.catch(() => {});
    try {
      return await Promise.race([answer, deadline]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchOutcome(at: number): Promise<Outcome> {
    const current = this.currentVersion();
    const transient = (error: UpdateError, retryNotBefore?: number): Outcome => ({
      kind: "transient",
      error,
      retryNotBefore,
    });
    const answered = (error: UpdateError): Outcome => ({
      kind: "state",
      state: { status: "error", current, checkedAt: at, error },
    });

    const reply = await this.request();
    if (!reply || "timedOut" in reply) return transient("offline");
    const { res, body } = reply;

    if (res.status === 404) return answered("no_release");
    if (!res.ok) {
      const limited =
        (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
      if (!limited) return transient("offline");
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
      return transient(
        "rate_limited",
        resetAt === undefined ? undefined : Math.min(resetAt, at + MAX_RATE_LIMIT_WAIT_MS),
      );
    }
    if (!body || typeof body !== "object") return transient("offline");

    const release = body as GithubRelease;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = tag.replace(/^v/, "");
    if (!PLAIN_VERSION.test(version)) return answered("no_release");
    if (!isNewerVersion(version, current)) {
      return { kind: "state", state: { status: "idle", current, checkedAt: at } };
    }

    const origin = this.origin;
    if (!origin) return answered("no_release");
    const assets = Array.isArray(release.assets) ? (release.assets as GithubAsset[]) : [];
    const find = (name: string) => findAsset(assets, name, (url) => origin.isAssetUrl(url, tag, name));
    const zipUrl = find(`nashir-${version}.zip`);
    if (!zipUrl) return answered("no_release");
    const sigUrl = find(`nashir-${version}.zip.sig`);
    if (!sigUrl) return answered("unsigned_release");

    const latest: LatestRelease = {
      version,
      // Built here, never read from the response: this link is shown to the user.
      notesUrl: origin.notesUrl(tag),
      zipUrl,
      sigUrl,
    };
    if (typeof release.published_at === "string" && release.published_at) {
      latest.publishedAt = release.published_at;
    }
    return { kind: "state", state: { status: "available", current, checkedAt: at, latest } };
  }
}

/** The URL of the asset with exactly this name, if the origin check accepts it. */
function findAsset(
  assets: GithubAsset[],
  name: string,
  accept: (url: string) => boolean,
): string | null {
  const url = assets.find((a) => a.name === name)?.browser_download_url;
  return typeof url === "string" && accept(url) ? url : null;
}
