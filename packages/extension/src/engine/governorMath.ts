import type {
  BudgetDomain,
  CallBudgetConfig,
  CooldownScope,
  CooldownState,
  EndpointClass,
  FbRecipe,
  GovernorVerdict,
  ThrottleClass,
  ThrottleVerdict,
} from "@nashir/shared";
import { fbErrorHaystack, fbErrorsOf, parseFbJson } from "./fbResponse.js";

/**
 * governorMath — pure call-governance maths. No ports, no clock, no chrome.
 *
 * Same split as `SafetyPolicy` / `CampaignEngine` and `feasibilityMath` /
 * `FeasibilityRunner`: every decision that can be a function of its inputs is one, and
 * `CallGovernor` is left holding nothing but storage and a clock.
 *
 * The unit of account here is a *call*, not a post. Facebook's throttle is
 * caller-attributed and summed across every subsystem, so a 26-page group sync and a
 * 40-chunk video upload spend from the same budget the composer does.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------- configuration

/**
 * Shipping defaults.
 *
 * Reads are paced but stay snappy — 600 ms turns the joined-groups walk from a
 * 26-request burst into something that finishes in seconds and looks like a person
 * scrolling. Mutations are spaced generously because they are what gets an account
 * restricted, and the campaign delay dominates them anyway.
 *
 * Uploads are a separate budget domain on purpose: they hit a different Facebook edge
 * (upload/vupload), and a long video must not be able to starve the posting budget.
 */
export const DEFAULT_CALL_BUDGET: CallBudgetConfig = {
  perDomain: {
    www: { perMinute: 20, perHour: 250 },
    upload: { perMinute: 60, perHour: 600 },
  },
  perAccountPerHour: 100,
  spacingMs: {
    "mutation.post": 30_000,
    "mutation.leave": 6_000,
    "read.groups": 600,
    "read.dialog": 600,
    "read.preview": 1_000,
    // Deliberately slower than read.groups. Group sync runs once every six hours;
    // an audience extraction is a burst the operator triggers and watches, so the
    // cost of pacing it is boredom, and the cost of not pacing it is the account.
    "read.audience": 1_500,
    // Unattended and recurring, so it is paced well below anything a person waits on.
    "read.feed": 4_000,
    // A comment is a write. Paced like one — nearer the composer than a read.
    "mutation.comment": 20_000,
    // Joins are the action most associated with restriction. Two a minute is already
    // far beyond anything this app should do unattended.
    "mutation.join": 45_000,
    "upload.photo": 500,
    "upload.video": 250,
    "page.load": 10_000,
    other: 750,
  },
  jitterFrac: 0.3,
  mutationConcurrency: 1,
  softThresholdPct: 80,
  // 15 minutes is chosen to be far longer than any exponential backoff would produce
  // (8s -> 16s -> 32s). That gap is the fix: Facebook's guidance is that calls made
  // during a block extend it, so the cure for a throttle is silence, not speed.
  cooldownLadderMs: [15 * MIN, 60 * MIN, 4 * HOUR, 12 * HOUR, 24 * HOUR],
  cooldownResetAfterCleanMs: HOUR,
  // A wait longer than this is refused rather than slept: the service worker is
  // evicted at ~30s idle and a long setTimeout loses the call entirely.
  maxSyncWaitMs: 20_000,
};

/** Merge recipe-supplied overrides, so a tightening at Facebook is a data change. */
export function withBudgetOverrides(
  base: CallBudgetConfig,
  over?: Partial<CallBudgetConfig>,
): CallBudgetConfig {
  if (!over) return base;
  return {
    ...base,
    ...over,
    perDomain: { ...base.perDomain, ...(over.perDomain ?? {}) },
    spacingMs: { ...base.spacingMs, ...(over.spacingMs ?? {}) },
  };
}

// ---------------------------------------------------------------- classification

/** Which budget pool a URL draws from, or null when it is not Facebook at all. */
export function domainOf(url: string): BudgetDomain | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return null;
  if (host === "upload.facebook.com" || /^vupload[\w-]*\.facebook\.com$/.test(host)) {
    return "upload";
  }
  return "www";
}

/**
 * What a request is *for*. Driven off the recipe's own friendly names where possible,
 * so a doc_id rotation cannot silently reclassify a mutation as a read; the string
 * heuristics are the fallback for a recipe that predates a new query.
 */
export function classifyEndpoint(
  url: string,
  friendlyName?: string,
  recipe?: FbRecipe,
): { domain: BudgetDomain; cls: EndpointClass } | null {
  const domain = domainOf(url);
  if (domain == null) return null;

  if (domain === "upload") {
    const cls: EndpointClass = /^https?:\/\/vupload/i.test(url) ? "upload.video" : "upload.photo";
    return { domain, cls };
  }

  const fn = friendlyName ?? "";
  if (recipe && fn) {
    if (fn === recipe.createGroupPost.friendlyName) return { domain, cls: "mutation.post" };
    if (fn === recipe.leaveGroup?.friendlyName) return { domain, cls: "mutation.leave" };
    if (fn === recipe.leaveGroupDialog?.friendlyName) return { domain, cls: "read.dialog" };
    if (fn === recipe.linkPreview?.friendlyName) return { domain, cls: "read.preview" };
    if (
      fn === recipe.joinedGroups.friendlyName ||
      fn === recipe.joinedGroupsPagination?.friendlyName
    ) {
      return { domain, cls: "read.groups" };
    }
    if (fn === recipe.groupFeed?.friendlyName) return { domain, cls: "read.feed" };
    if (fn === recipe.createComment?.friendlyName) return { domain, cls: "mutation.comment" };
    if (fn === recipe.joinGroup?.friendlyName) return { domain, cls: "mutation.join" };
    if (fn === recipe.groupSearch?.friendlyName) return { domain, cls: "read.groups" };
    if (fn === recipe.groupMembers?.friendlyName) return { domain, cls: "read.audience" };
    const aud = recipe.postAudience;
    if (
      aud &&
      (fn === aud.reactions.friendlyName ||
        fn === aud.reactionsFirst?.friendlyName ||
        fn === aud.comments.friendlyName ||
        fn === aud.commentsPaging?.friendlyName)
    ) {
      return { domain, cls: "read.audience" };
    }
  }

  if (/composer|storycreate/i.test(fn)) return { domain, cls: "mutation.post" };
  if (/leave/i.test(fn) && /mutation/i.test(fn)) return { domain, cls: "mutation.leave" };
  if (/join/i.test(fn) && /mutation/i.test(fn)) return { domain, cls: "mutation.join" };
  if (/comment/i.test(fn) && /(create|mutation)/i.test(fn)) return { domain, cls: "mutation.comment" };
  // Before the audience and group rules: a group feed query is named "GroupsComet…"
  // and carries "Feed", so both later rules would otherwise claim it.
  if (/feed.*(pagination|stories|route)|stories.*pagination/i.test(fn)) {
    return { domain, cls: "read.feed" };
  }
  if (/members/i.test(fn)) return { domain, cls: "read.audience" };
  if (/preview|attachment/i.test(fn)) return { domain, cls: "read.preview" };
  // Before the /group/i catch-all on purpose: the reactions and comments queries on a
  // group post are named "GroupsComet...", so the group rule would swallow them and
  // bill an unbounded paginating read at the group budget's spacing.
  if (/reaction|reactors|ufi.*comment|comment.*(list|thread|replies|provider)/i.test(fn)) {
    return { domain, cls: "read.audience" };
  }
  if (/group/i.test(fn)) return { domain, cls: "read.groups" };
  return { domain, cls: "other" };
}

/** Mutations are serialised; reads and uploads are not. */
export function isMutation(cls: EndpointClass): boolean {
  return (
    cls === "mutation.post" ||
    cls === "mutation.leave" ||
    cls === "mutation.comment" ||
    cls === "mutation.join"
  );
}

// ---------------------------------------------------------------- throttle detection

export interface DetectInput {
  /** HTTP status, when there was one. Absent for a network-level failure. */
  status?: number;
  /** Response headers, keys lower-cased. Usually empty on internal www endpoints. */
  headers?: Record<string, string>;
  /**
   * The response body, or — when called from an error path — a bare error string.
   * Both are handled: an unparseable body is matched as plain text.
   */
  bodyText?: string;
  recipe: FbRecipe;
}

/** Signals that name a number are matched as codes, never as substrings. */
function textSignals(signals: string[] | undefined): string[] {
  return (signals ?? []).filter((s) => !/^\d+$/.test(s.trim())).map((s) => s.toLowerCase());
}

function firstMatch(haystack: string, signals: string[]): string | undefined {
  return signals.find((s) => s.length > 0 && haystack.includes(s));
}

/**
 * A "temporarily blocked" message is a policy block measured in hours or days, not a
 * rate limit measured in minutes. It sits in `rateLimitSignals` for historical
 * reasons, so it is pulled out here and matched before the rate-limit pass.
 */
const POLICY_BLOCK_PHRASES = [
  "temporarily blocked",
  "temporarily restricted",
  "blocked from posting",
  "action blocked",
];

/** Checkpoint copy that is unambiguous. "temporarily blocked" is deliberately absent. */
const CHECKPOINT_PHRASES = ["checkpoint", "confirm your identity", "confirm it is you"];

function parseRetryAfter(raw: string | undefined, nowMs: number): number | undefined {
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/**
 * Utilisation 0..1 from whichever usage header is present.
 *
 * These are Graph API headers. The internal www endpoints this extension calls
 * generally omit them, which is exactly why every class below must also be reachable
 * from the body alone — the headers are a bonus, never the mechanism.
 */
function readPressure(headers: Record<string, string>): number | undefined {
  const pcts: number[] = [];
  const collect = (raw: string | undefined, keys: string[]): void => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const k of keys) {
        const v = parsed[k];
        if (typeof v === "number") pcts.push(v);
      }
    } catch {
      /* a malformed header is simply no signal */
    }
  };
  collect(headers["x-app-usage"], ["call_count", "total_time", "total_cputime"]);
  collect(headers["x-fb-ads-insights-throttle"], ["app_id_util_pct", "acc_id_util_pct"]);
  if (pcts.length === 0) return undefined;
  return Math.max(...pcts) / 100;
}

/** `estimated_time_to_regain_access` is in minutes, and is Facebook telling us exactly. */
function readBucRetryMs(headers: Record<string, string>): number | undefined {
  const raw = headers["x-business-use-case-usage"];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let best: number | undefined;
    for (const entries of Object.values(parsed)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        const mins = (e as Record<string, unknown>)?.estimated_time_to_regain_access;
        if (typeof mins === "number" && mins > 0) best = Math.max(best ?? 0, mins * MIN);
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Classify one Facebook response.
 *
 * Precedence is codes before copy, because codes cannot be ambiguous and copy always
 * is. Status comes last so that a 200 carrying an error body — which is how the
 * internal endpoints report a throttle — never reads as clean.
 */
export function detectThrottle(input: DetectInput, nowMs = 0): ThrottleVerdict {
  const { recipe } = input;
  const headers = input.headers ?? {};
  const body = input.bodyText ?? "";

  const parsed = parseFbJson(body);
  const errors = fbErrorsOf(parsed);
  // An unparseable body (or a bare error string from a catch block) is still evidence.
  const haystack = errors.length ? fbErrorHaystack(errors) : body.toLowerCase();
  const codes = errors.map((e) => e.code).filter((c): c is number => typeof c === "number");

  const pressure = readPressure(headers);
  const retryAfterMs = parseRetryAfter(headers["retry-after"], nowMs) ?? readBucRetryMs(headers);
  const evidence = (errors.length ? fbErrorHaystack(errors) : body).slice(0, 500) || undefined;

  const verdict = (
    cls: ThrottleClass,
    scope: CooldownScope,
    matchedSignal: string,
  ): ThrottleVerdict => ({
    class: cls,
    scope,
    retryAfterMs,
    pressure,
    code: codes[0],
    subcode: errors.find((e) => e.subcode != null)?.subcode,
    evidence: cls === "none" ? undefined : evidence,
    matchedSignal,
  });

  // ---- codes first ----
  const checkpointCodes = recipe.checkpointCodes ?? [];
  const policyCodes = recipe.policyBlockCodes ?? [];
  const rateCodes = recipe.rateLimitCodes ?? [];

  for (const c of codes) {
    if (checkpointCodes.includes(c)) return verdict("checkpoint", "account", "code:" + c);
  }
  for (const c of codes) {
    if (policyCodes.includes(c)) return verdict("policy_block", "account", "code:" + c);
  }
  for (const c of codes) {
    // 80000-80999 is the business-use-case throttle family; matched by span so a new
    // member does not need a recipe publish to be recognised.
    if (rateCodes.includes(c) || (c >= 80000 && c <= 80999)) {
      // 4 and 341 are app-wide; 17 is the user's own quota.
      return verdict("rate_limit", c === 17 ? "account" : "global", "code:" + c);
    }
  }

  // ---- then copy ----
  const cp = firstMatch(haystack, [
    ...CHECKPOINT_PHRASES,
    ...textSignals(recipe.checkpointSignals).filter(
      (s) => !POLICY_BLOCK_PHRASES.some((p) => s.includes(p)),
    ),
  ]);
  if (cp) return verdict("checkpoint", "account", cp);

  const pb = firstMatch(haystack, POLICY_BLOCK_PHRASES);
  if (pb) return verdict("policy_block", "account", pb);

  const rl = firstMatch(haystack, textSignals(recipe.rateLimitSignals));
  if (rl) {
    // "from this app" is Facebook naming the caller; "this account" names the user.
    const perUser = /user request limit|calls from this account/.test(haystack);
    return verdict("rate_limit", perUser ? "account" : "global", rl);
  }

  // ---- status last ----
  if (input.status === 429) return verdict("rate_limit", "global", "http:429");
  if (input.status != null && input.status >= 500) {
    return verdict("transient", "global", "http:" + input.status);
  }
  if (errors.some((e) => e.isTransient)) return verdict("transient", "global", "is_transient");
  if (
    input.status == null &&
    parsed == null &&
    /network|failed to fetch|timeout|aborted/i.test(body)
  ) {
    return verdict("transient", "global", "network");
  }

  return verdict("none", "global", "");
}

/** Does this verdict mean stop, rather than retry? */
export function opensCooldown(v: ThrottleVerdict): boolean {
  return v.class === "rate_limit" || v.class === "policy_block" || v.class === "checkpoint";
}

// ---------------------------------------------------------------- backoff

/**
 * How long to stay silent, given how many throttles have landed in a row.
 *
 * Equal jitter — uniform in [hi/2, hi] — deliberately, not full jitter. Full jitter
 * draws values near zero, which is a call straight back into a live block; the point
 * of a cooldown is that it cannot accidentally turn out to be short.
 *
 * A server-stated wait always wins: Facebook knows when it will let us back in.
 */
export function nextCooldownMs(
  consecutive: number,
  cfg: CallBudgetConfig,
  rand: () => number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    // Floored: a Retry-After of two seconds is not permission to hammer.
    return Math.max(MIN, Math.round(retryAfterMs * (1 + rand() * 0.1)));
  }
  const ladder = cfg.cooldownLadderMs;
  const hi = ladder[Math.min(Math.max(1, consecutive), ladder.length) - 1] ?? ladder[0] ?? 15 * MIN;
  return Math.round(hi / 2 + rand() * (hi / 2));
}

/** Minimum gap for a class, doubled when Facebook says we are near its ceiling. */
export function spacingFor(cls: EndpointClass, cfg: CallBudgetConfig, pressure?: number): number {
  const base = cfg.spacingMs[cls] ?? cfg.spacingMs.other;
  const strained = pressure != null && pressure * 100 >= cfg.softThresholdPct;
  return strained ? base * 2 : base;
}

export function jittered(ms: number, frac: number, rand: () => number): number {
  return Math.max(0, Math.round(ms * (1 + (rand() - 0.5) * 2 * frac)));
}

// ---------------------------------------------------------------- the ring

/**
 * A 60-slot minute ring, indexed by `epochMinute % 60`.
 *
 * Persisted, because MV3 evicts the service worker every ~30 seconds and any state
 * that governs Facebook traffic must survive that or it does not exist. (The bug this
 * whole feature exists to fix was exactly an in-memory counter that never did.)
 * A ring keeps writes O(1) and the record a couple of kilobytes forever.
 */
export interface GovernorRing {
  version: 1;
  /** Epoch minute the ring was last advanced to. */
  minute: number;
  global: Record<BudgetDomain, number[]>;
  byClass: Partial<Record<EndpointClass, number[]>>;
  byAccount: Record<string, number[]>;
  lastCallAt: Partial<Record<EndpointClass, number>>;
  cooldown: CooldownState | null;
  consecutiveThrottles: number;
  /** When the current run of clean calls started; drives the ladder reset. */
  cleanSince: number;
  lastThrottleAt: number | null;
  /**
   * Last utilisation Facebook reported, 0..1, or null when it has never said. Kept so
   * pacing stays widened across calls rather than only on the response that carried
   * the header.
   */
  pressure: number | null;
}

const SLOTS = 60;
const zeros = (): number[] => new Array<number>(SLOTS).fill(0);

export function emptyRing(nowMs: number): GovernorRing {
  return {
    version: 1,
    minute: Math.floor(nowMs / MIN),
    global: { www: zeros(), upload: zeros() },
    byClass: {},
    byAccount: {},
    lastCallAt: {},
    cooldown: null,
    consecutiveThrottles: 0,
    cleanSince: nowMs,
    lastThrottleAt: null,
    pressure: null,
  };
}

function clearRange(slots: number[], fromMinute: number, toMinute: number): void {
  const span = Math.min(SLOTS, toMinute - fromMinute);
  for (let i = 1; i <= span; i++) slots[(fromMinute + i) % SLOTS] = 0;
}

/** Roll the ring forward to `nowMs`, zeroing the minutes that elapsed while idle. */
export function advance(ring: GovernorRing, nowMs: number): GovernorRing {
  const minute = Math.floor(nowMs / MIN);
  if (minute <= ring.minute) return ring;
  for (const slots of Object.values(ring.global)) clearRange(slots, ring.minute, minute);
  for (const slots of Object.values(ring.byClass)) {
    if (slots) clearRange(slots, ring.minute, minute);
  }
  for (const slots of Object.values(ring.byAccount)) clearRange(slots, ring.minute, minute);
  ring.minute = minute;
  return ring;
}

const total = (slots: number[] | undefined): number => (slots ?? []).reduce((a, b) => a + b, 0);

export function countsFor(
  ring: GovernorRing,
  domain: BudgetDomain,
): { minute: number; hour: number } {
  return {
    minute: ring.global[domain]?.[ring.minute % SLOTS] ?? 0,
    hour: total(ring.global[domain]),
  };
}

/** Record one call against every counter it belongs to. */
export function recordCall(
  ring: GovernorRing,
  domain: BudgetDomain,
  cls: EndpointClass,
  accountId: string | undefined,
  nowMs: number,
): GovernorRing {
  advance(ring, nowMs);
  const i = ring.minute % SLOTS;
  ring.global[domain][i] = (ring.global[domain][i] ?? 0) + 1;
  const byClass = (ring.byClass[cls] ??= zeros());
  byClass[i] = (byClass[i] ?? 0) + 1;
  if (accountId) {
    const byAcct = (ring.byAccount[accountId] ??= zeros());
    byAcct[i] = (byAcct[i] ?? 0) + 1;
  }
  ring.lastCallAt[cls] = nowMs;
  return ring;
}

/**
 * May a call of this class go out now, and if not, when?
 *
 * Side-effect free — `CallGovernor` decides with this, then records separately. That
 * split is what lets a caller *ask* without spending budget on the question.
 */
export function budgetVerdict(
  ring: GovernorRing,
  domain: BudgetDomain,
  cls: EndpointClass,
  accountId: string | undefined,
  nowMs: number,
  cfg: CallBudgetConfig,
  rand: () => number,
  pressure?: number,
): GovernorVerdict {
  const cd = ring.cooldown;
  if (cd && (cd.requiresOperator || nowMs < cd.untilMs)) {
    return {
      allowed: false,
      // A checkpoint has no timer: no wait clears it, only a person in a Facebook tab.
      waitMs: cd.requiresOperator ? Number.POSITIVE_INFINITY : cd.untilMs - nowMs,
      retryAtMs: cd.requiresOperator ? undefined : cd.untilMs,
      reason: "cooldown",
      cooldown: cd,
    };
  }

  const limits = cfg.perDomain[domain];
  const counts = countsFor(ring, domain);
  const nextMinuteAt = (ring.minute + 1) * MIN;
  const budgetRefusal = (reason: GovernorVerdict["reason"]): GovernorVerdict => ({
    allowed: false,
    waitMs: Math.max(0, nextMinuteAt - nowMs),
    retryAtMs: nextMinuteAt,
    reason,
  });

  if (counts.minute >= limits.perMinute) return budgetRefusal("minute_budget");
  if (counts.hour >= limits.perHour) return budgetRefusal("hour_budget");
  if (accountId && total(ring.byAccount[accountId]) >= cfg.perAccountPerHour) {
    return budgetRefusal("account_budget");
  }

  const last = ring.lastCallAt[cls];
  if (last != null) {
    const readyAt = last + jittered(spacingFor(cls, cfg, pressure), cfg.jitterFrac, rand);
    if (nowMs < readyAt) {
      return { allowed: false, waitMs: readyAt - nowMs, retryAtMs: readyAt, reason: "spacing" };
    }
  }

  return { allowed: true, waitMs: 0 };
}
