import type { Account, AccountAuth, AccountHealth, FbProfile } from "@nashir/shared";
import type { CookiePort, StoragePort, CryptoPort, TabPort, LoggerPort } from "./ports/index.js";

const FB_URL = "https://www.facebook.com";
const ACCOUNTS_KEY = "nashir:accounts";
const authKey = (id: string) => `nashir:auth:${id}`;

/** The FB cookies that constitute a session. Order matters only for logging. */
const SESSION_COOKIES = ["c_user", "xs", "fr", "datr", "sb"] as const;

/** The placeholder label a new account gets until a profile scrape supplies a real name. */
const defaultLabel = (fbUserId: string) => `Account ${fbUserId}`;

/**
 * CookieAccountManager — the encrypted, same-device multi-account cookie-swap engine.
 *
 * Chrome has one cookie jar per profile, so only ONE FB account is active at a time.
 * We serialize all swaps behind an internal mutex, and always snapshot→swap→work→restore
 * so the user's real session is intact afterward. Auth cookies are AES-GCM encrypted at
 * rest (via CryptoPort). Same-device only: capture live here, replay here — importing a
 * session from another machine trips FB's device-bound `datr`/fingerprint checks.
 */
export class CookieAccountManager {
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * The account whose cookies are installed right now, or null for the user's own
   * session. The swap mutex guarantees there is only ever one, which is what makes
   * this safe to read as ambient context — the call governor uses it to bill a request
   * to the right account without every call site having to thread an id through.
   */
  private active: string | null = null;

  constructor(
    private readonly cookies: CookiePort,
    private readonly storage: StoragePort,
    private readonly crypto: CryptoPort,
    private readonly tab: TabPort,
    private readonly logger: LoggerPort,
    private readonly governor?: {
      acquire(domain: "www", cls: "page.load", accountId?: string): Promise<void>;
    },
  ) {}

  async listAccounts(): Promise<Account[]> {
    return (await this.storage.get<Account[]>(ACCOUNTS_KEY)) ?? [];
  }

  /** Capture the currently logged-in FB session as a new managed account. */
  async addAccountFromSession(label?: string): Promise<Account> {
    const auth = await this.captureCurrent();
    if (!auth.c_user || !auth.xs) {
      throw new Error("No logged-in Facebook session found in this browser.");
    }
    const accounts = await this.listAccounts();
    const existing = accounts.find((a) => a.fbUserId === auth.c_user);
    const id = existing?.id ?? `acc_${auth.c_user}_${accounts.length + 1}`;

    await this.storeAuth(id, auth);

    const account: Account = existing ?? {
      id,
      fbUserId: auth.c_user,
      label: label ?? defaultLabel(auth.c_user),
      addedAt: Date.now(),
      health: "ok",
      dailyCounts: {},
    };
    account.health = "ok";
    account.lastActiveAt = Date.now();

    const next = existing ? accounts.map((a) => (a.id === id ? account : a)) : [...accounts, account];
    await this.storage.set(ACCOUNTS_KEY, next);
    this.logger.info("Account added from session", { id, fbUserId: auth.c_user });
    return account;
  }

  /** Merge a patch into one account's metadata. Returns the updated record, or null if gone. */
  async updateAccount(accountId: string, patch: Partial<Account>): Promise<Account | null> {
    const accounts = await this.listAccounts();
    const current = accounts.find((a) => a.id === accountId);
    if (!current) return null;
    const updated = { ...current, ...patch, id: current.id };
    await this.storage.set(
      ACCOUNTS_KEY,
      accounts.map((a) => (a.id === accountId ? updated : a)),
    );
    return updated;
  }

  /**
   * Fold a freshly scraped profile into an account.
   *
   * `label` is the user's own name for the account, so it is only overwritten while it
   * still holds the placeholder we generated — a rename must survive every re-scrape.
   */
  async applyProfile(accountId: string, profile: FbProfile): Promise<Account | null> {
    const accounts = await this.listAccounts();
    const current = accounts.find((a) => a.id === accountId);
    if (!current) return null;
    const renamed = current.label !== defaultLabel(current.fbUserId) && current.label !== current.name;
    return this.updateAccount(accountId, {
      name: profile.name ?? current.name,
      avatarUrl: profile.avatarUrl ?? current.avatarUrl,
      profileUrl: profile.profileUrl ?? current.profileUrl,
      profileScrapedAt: Date.now(),
      label: renamed ? current.label : (profile.name ?? current.label),
    });
  }

  async removeAccount(accountId: string): Promise<void> {
    const accounts = await this.listAccounts();
    await this.storage.set(ACCOUNTS_KEY, accounts.filter((a) => a.id !== accountId));
    await this.storage.remove(authKey(accountId));
  }

  /**
   * Run `fn` with `accountId`'s session active, restoring the prior session afterward.
   * Serialized: only one account is ever active at a time.
   */
  /** The account a Facebook request made right now would be attributed to. */
  activeAccountId(): string | null {
    return this.active;
  }

  async withAccount<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = await this.captureCurrent();
      try {
        await this.activate(accountId);
        this.active = accountId;
        return await fn();
      } finally {
        this.active = null;
        await this.restore(snapshot);
      }
    };
    // Chain onto the mutex so swaps never interleave.
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Decrypt + write an account's cookies, then verify the swap took. */
  async activate(accountId: string): Promise<void> {
    const auth = await this.loadAuth(accountId);
    if (!auth) throw new Error(`No stored auth for account ${accountId}`);
    await this.writeSession(auth);

    const cUser = await this.cookies.get(FB_URL, "c_user");
    if (cUser?.value !== auth.c_user) {
      throw new Error(`Cookie swap verification failed for ${accountId} (c_user mismatch)`);
    }
  }

  /** Restore a previously captured session (no-op if it was empty/logged-out). */
  async restore(snapshot: AccountAuth): Promise<void> {
    if (!snapshot.c_user) {
      // Nothing was logged in before; clear our swapped cookies to avoid leaking a session.
      for (const name of SESSION_COOKIES) await this.cookies.remove(FB_URL, name);
      return;
    }
    await this.writeSession(snapshot);
  }

  /** Read the current FB session cookies straight from the jar. */
  async captureCurrent(): Promise<AccountAuth> {
    const all = await this.cookies.getAll(FB_URL);
    const byName = new Map(all.map((c) => [c.name, c.value]));
    return {
      c_user: byName.get("c_user") ?? "",
      xs: byName.get("xs") ?? "",
      fr: byName.get("fr"),
      datr: byName.get("datr"),
      sb: byName.get("sb"),
    };
  }

  /**
   * Classify an account's live session. Requires the account to be ACTIVE (call inside
   * withAccount / after activate). Uses the content script's health probe.
   */
  async healthCheck(): Promise<AccountHealth> {
    try {
      const tabId = await this.tab.ensureFacebookTab();
      // Same reasoning as TokenScraper: a reload is dozens of Facebook requests that
      // the HttpPort decorator is structurally blind to.
      await this.governor?.acquire("www", "page.load");
      await this.tab.reloadAndWait(tabId);
      const res = await this.tab.callContent<{ health: AccountHealth }>(tabId, {
        type: "CHECK_HEALTH",
      });
      return res.ok && res.data ? res.data.health : "unknown";
    } catch {
      return "unknown";
    }
  }

  // ---- internals ----

  private async writeSession(auth: AccountAuth): Promise<void> {
    const write = (name: string, value: string | undefined, httpOnly: boolean) => {
      if (value == null || value === "") return this.cookies.remove(FB_URL, name);
      return this.cookies.set({
        url: FB_URL,
        name,
        value,
        domain: ".facebook.com",
        path: "/",
        secure: true,
        httpOnly,
        sameSite: "no_restriction",
        // ~1 year; FB will refresh as needed.
        expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      });
    };
    // c_user is readable by JS; xs/fr/datr/sb are HttpOnly. Extensions may set HttpOnly.
    await write("c_user", auth.c_user, false);
    await write("xs", auth.xs, true);
    await write("fr", auth.fr, true);
    await write("datr", auth.datr, true);
    await write("sb", auth.sb, true);
    if (auth.extra) {
      for (const [name, value] of Object.entries(auth.extra)) await write(name, value, true);
    }
  }

  private async storeAuth(accountId: string, auth: AccountAuth): Promise<void> {
    const sealed = await this.crypto.seal(JSON.stringify(auth));
    await this.storage.set(authKey(accountId), sealed);
  }

  private async loadAuth(accountId: string): Promise<AccountAuth | null> {
    const sealed = await this.storage.get<{ ct: string; iv: string; v: number }>(authKey(accountId));
    if (!sealed) return null;
    const plain = await this.crypto.open(sealed);
    return JSON.parse(plain) as AccountAuth;
  }
}
