import type {
  CheckId,
  CheckRecord,
  CheckVerdict,
  FbRecipe,
  FeasibilityRecord,
  MeasuredDefaults,
  StepResult,
} from "@nashir/shared";
import { detectThrottle } from "./governorMath.js";

/**
 * Pure feasibility maths — no ports, no clock, no Facebook. `FeasibilityRunner` does the
 * talking; everything here is a function of its results, the same split `SafetyPolicy`
 * and `analyticsRollup` use.
 *
 * The dashboard imports this module directly, which is the other reason it is separate:
 * the report page needs `measuredDefaults` and `gatePassed` without dragging
 * `FacebookClient` into the page bundle.
 */

export function emptyRecord(now: number): FeasibilityRecord {
  const blank = (id: CheckId): CheckRecord => ({ id, verdict: "unrun", steps: [] });
  return {
    version: 1,
    checks: { post: blank("post"), swap: blank("swap"), ramp: blank("ramp") },
    updatedAt: now,
  };
}

/**
 * A check passes only if nothing failed. A warning downgrades it to `partial` rather
 * than passing it silently — an advisory problem the operator never sees is the same as
 * no check at all.
 */
export function verdictFor(steps: StepResult[]): CheckVerdict {
  if (steps.length === 0) return "unrun";
  if (steps.some((s) => s.status === "fail")) return "fail";
  if (steps.some((s) => s.status === "warn")) return "partial";
  return "pass";
}

/**
 * Did Facebook refuse this for volume or policy reasons?
 *
 * Delegates to `detectThrottle` so there is exactly one definition of a throttle in
 * the codebase. The signature is unchanged on purpose: `FeasibilityRunner` keeps
 * calling it as before, and its existing tests are the proof this is a pure
 * substitution rather than a change of meaning.
 *
 * A checkpoint is excluded. It stops the ramp for a different reason and must not be
 * read as a measured rate ceiling.
 */
export function isRateLimited(error: string, recipe: FbRecipe): boolean {
  const verdict = detectThrottle({ bodyText: error, recipe });
  return verdict.class === "rate_limit" || verdict.class === "policy_block";
}

/**
 * Turn a measured ceiling into shipping defaults.
 *
 * Deliberately conservative: the ceiling is the rate at which Facebook was still
 * tolerating us, and running a product at the edge of tolerance is how accounts get
 * restricted. 60% of the measured rate leaves room for the account's own organic
 * activity and for a bad day on Facebook's side.
 */
export function measuredDefaults(ceilingPostsPerHour: number): MeasuredDefaults {
  const safeRate = Math.max(1, ceilingPostsPerHour * 0.6);
  const meanSeconds = Math.round(3600 / safeRate);
  return {
    ceilingPostsPerHour,
    // ±30% around the mean: the jitter is what stops the cadence looking mechanical.
    minSeconds: Math.max(15, Math.round(meanSeconds * 0.7)),
    maxSeconds: Math.max(30, Math.round(meanSeconds * 1.3)),
    // Roughly an hour of posting, then a real pause.
    breakEveryNPosts: Math.max(5, Math.round(safeRate)),
    breakSeconds: 600,
    // An eight-hour "working day" at the safe rate, not twenty-four.
    dailyBudgetPerAccount: Math.max(10, Math.round(safeRate * 8)),
    // The same safe rate, stated in the unit Facebook actually counts. The ramp posts
    // text, so one post was one call while it was measuring; the governor converts
    // this into a ceiling that holds regardless of what a campaign attaches.
    callBudgetPerHour: Math.max(1, Math.round(safeRate)),
  };
}

/**
 * Has the Phase-1 gate actually been passed?
 *
 * `partial` counts: a warning means the check ran and produced its answer with an
 * advisory attached. `unrun` never counts — the whole point of this record is that
 * "we didn't check" and "we checked and it was fine" stop looking alike.
 */
export function gatePassed(record: FeasibilityRecord): boolean {
  return (["post", "swap", "ramp"] as CheckId[]).every((id) => {
    const verdict = record.checks[id]?.verdict;
    return verdict === "pass" || verdict === "partial";
  });
}
