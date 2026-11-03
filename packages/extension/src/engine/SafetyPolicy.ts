import type {
  DelayConfig,
  SafetyBreakConfig,
  AntiDetectionConfig,
  DelayRecommendation,
  RiskLevel,
} from "@nashir/shared";

/**
 * Pure anti-detection math. No side effects, no chrome.*, no clock — callers pass
 * a deterministic `rand` (0..1) so this is fully unit-testable. In production the
 * caller supplies Math.random; tests supply a seeded sequence.
 */

export interface RunContext {
  /** How many posts have completed in this run so far. */
  completedCount: number;
  /** Total posts in the run. */
  totalCount: number;
  /** 0..1 random source. */
  rand: () => number;
}

/** Compute the delay (ms) before the next post. */
export function nextDelayMs(
  delay: DelayConfig,
  anti: AntiDetectionConfig,
  ctx: RunContext,
): number {
  const minMs = delay.minSeconds * 1000;
  const maxMs = Math.max(minMs, delay.maxSeconds * 1000);

  // Base: uniform pick within [min, max] (fixed mode has min === max).
  let base = delay.mode === "fixed" ? minMs : minMs + ctx.rand() * (maxMs - minMs);

  // Warmup: the first few posts of a run go slower, easing toward the base range.
  if (anti.warmup) {
    const warmupPosts = 5;
    if (ctx.completedCount < warmupPosts) {
      const factor = 1 + (warmupPosts - ctx.completedCount) * 0.25; // up to 2.25x on post 0
      base *= factor;
    }
  }

  // Jitter: +/- up to 20% human-like noise so intervals aren't machine-regular.
  if (anti.jitter) {
    const jitterFrac = (ctx.rand() - 0.5) * 0.4; // -0.2 .. +0.2
    base *= 1 + jitterFrac;
  }

  return Math.max(1000, Math.round(base));
}

/** Whether a safety break should trigger now (before the next post). */
export function shouldSafetyBreak(
  cfg: SafetyBreakConfig,
  postsSinceBreak: number,
): boolean {
  return cfg.enabled && postsSinceBreak > 0 && postsSinceBreak % cfg.everyNPosts === 0;
}

/** Backoff after a failure; may recommend auto-pausing the whole run. */
export function backoffAfterFailure(
  anti: AntiDetectionConfig,
  consecutiveFailures: number,
): { waitMs: number; autoPause: boolean } {
  // Exponential backoff, capped at 5 minutes.
  const waitMs = Math.min(5 * 60_000, 8_000 * 2 ** Math.max(0, consecutiveFailures - 1));
  const autoPause =
    anti.autoPauseAfterConsecutiveFailures > 0 &&
    consecutiveFailures >= anti.autoPauseAfterConsecutiveFailures;
  return { waitMs, autoPause };
}

/**
 * Recommend the safest delay tier for a given group count.
 * Grounded by the Phase-1c rate-limit reality check; these thresholds are the
 * conservative starting defaults until that evidence refines them.
 */
export function recommendDelay(
  groupCount: number,
  accountAgeDays = 365,
): DelayRecommendation {
  let minSeconds: number;
  let maxSeconds: number;
  let riskLevel: RiskLevel;
  let reason: string;

  if (groupCount <= 5) {
    minSeconds = 60;
    maxSeconds = 180;
    riskLevel = "safe";
    reason = "Small batch — a 1–3 minute spacing looks natural.";
  } else if (groupCount <= 20) {
    minSeconds = 180;
    maxSeconds = 1200;
    riskLevel = "moderate";
    reason = "Medium batch — widen spacing to 3–20 minutes to avoid rate flags.";
  } else if (groupCount <= 50) {
    minSeconds = 1200;
    maxSeconds = 1800;
    riskLevel = "risky";
    reason = "Large batch — 20–30 minute spacing recommended; consider splitting across days.";
  } else {
    minSeconds = 1800;
    maxSeconds = 3600;
    riskLevel = "dangerous";
    reason = "Very large batch — spread over multiple sessions/days; 30–60 minute spacing minimum.";
  }

  // New accounts are far more likely to be flagged — push toward safer spacing.
  if (accountAgeDays < 30) {
    minSeconds = Math.max(minSeconds, 300);
    maxSeconds = Math.max(maxSeconds, 1800);
    if (riskLevel === "safe") riskLevel = "moderate";
    reason += " Account is new (<30 days) — extra spacing applied.";
  }

  return { minSeconds, maxSeconds, riskLevel, reason };
}

/** Is a proposed delay too aggressive for the group count? (drives the warning modal) */
export function assessRisk(
  delay: DelayConfig,
  groupCount: number,
  accountAgeDays = 365,
): { risky: boolean; recommendation: DelayRecommendation } {
  const rec = recommendDelay(groupCount, accountAgeDays);
  // "risky" if the user's chosen min is below the recommended min.
  const risky = delay.minSeconds < rec.minSeconds;
  return { risky, recommendation: rec };
}

/**
 * Estimate a campaign's wall-clock duration (ms): the first post fires immediately,
 * then each subsequent post waits the average delay, plus safety-break pauses.
 */
export function estimateRunMs(
  totalPosts: number,
  delay: DelayConfig,
  safety: SafetyBreakConfig,
): number {
  if (totalPosts <= 1) return 0;
  const gaps = totalPosts - 1;
  const avgDelaySec = delay.mode === "fixed" ? delay.minSeconds : (delay.minSeconds + delay.maxSeconds) / 2;
  let ms = gaps * avgDelaySec * 1000;
  if (safety.enabled && safety.everyNPosts > 0) {
    const breaks = Math.floor(totalPosts / safety.everyNPosts);
    ms += breaks * safety.durationSeconds * 1000;
  }
  return Math.round(ms);
}

/** Rough ACTIVE clicking effort a human would spend posting manually (ms). */
export function manualEffortMs(totalPosts: number): number {
  // ~40s of hands-on effort per group (navigate, paste, attach, submit).
  return totalPosts * 40_000;
}

/** Today's date key (UTC) for daily budget bookkeeping. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Remaining daily budget for an account (Infinity when unlimited). */
export function dailyBudgetRemaining(
  anti: AntiDetectionConfig,
  usedToday: number,
): number {
  if (anti.dailyBudgetPerAccount <= 0) return Infinity;
  return Math.max(0, anti.dailyBudgetPerAccount - usedToday);
}
