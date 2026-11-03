import { describe, it, expect } from "vitest";
import {
  nextDelayMs,
  shouldSafetyBreak,
  backoffAfterFailure,
  recommendDelay,
  assessRisk,
  dailyBudgetRemaining,
  dayKey,
  estimateRunMs,
} from "./SafetyPolicy.js";
import type { DelayConfig, AntiDetectionConfig, SafetyBreakConfig } from "@nashir/shared";

const anti: AntiDetectionConfig = {
  jitter: false,
  warmup: false,
  dailyBudgetPerAccount: 0,
  autoPauseAfterConsecutiveFailures: 3,
};

const ctx = (rand = 0.5, completed = 10) => ({ completedCount: completed, totalCount: 100, rand: () => rand });

describe("nextDelayMs", () => {
  it("fixed mode returns exactly the fixed value", () => {
    const cfg: DelayConfig = { mode: "fixed", minSeconds: 30, maxSeconds: 30 };
    expect(nextDelayMs(cfg, anti, ctx())).toBe(30_000);
  });

  it("range mode picks within [min,max] using rand", () => {
    const cfg: DelayConfig = { mode: "range", minSeconds: 60, maxSeconds: 180 };
    expect(nextDelayMs(cfg, anti, ctx(0))).toBe(60_000); // rand=0 -> min
    expect(nextDelayMs(cfg, anti, ctx(1))).toBe(180_000); // rand=1 -> max
    expect(nextDelayMs(cfg, anti, ctx(0.5))).toBe(120_000); // midpoint
  });

  it("warmup slows the first posts", () => {
    const cfg: DelayConfig = { mode: "fixed", minSeconds: 60, maxSeconds: 60 };
    const warm: AntiDetectionConfig = { ...anti, warmup: true };
    const post0 = nextDelayMs(cfg, warm, ctx(0.5, 0));
    const post10 = nextDelayMs(cfg, warm, ctx(0.5, 10));
    expect(post0).toBeGreaterThan(post10);
  });

  it("never returns below the 1s floor", () => {
    const cfg: DelayConfig = { mode: "fixed", minSeconds: 0, maxSeconds: 0 };
    expect(nextDelayMs(cfg, anti, ctx())).toBeGreaterThanOrEqual(1000);
  });
});

describe("shouldSafetyBreak", () => {
  const cfg: SafetyBreakConfig = { enabled: true, everyNPosts: 3, durationSeconds: 300 };
  it("triggers on multiples of N", () => {
    expect(shouldSafetyBreak(cfg, 3)).toBe(true);
    expect(shouldSafetyBreak(cfg, 6)).toBe(true);
  });
  it("does not trigger off-multiple or at zero", () => {
    expect(shouldSafetyBreak(cfg, 0)).toBe(false);
    expect(shouldSafetyBreak(cfg, 2)).toBe(false);
  });
  it("respects the enabled flag", () => {
    expect(shouldSafetyBreak({ ...cfg, enabled: false }, 3)).toBe(false);
  });
});

describe("backoffAfterFailure", () => {
  it("grows exponentially and caps at 5 minutes", () => {
    expect(backoffAfterFailure(anti, 1).waitMs).toBe(8_000);
    expect(backoffAfterFailure(anti, 2).waitMs).toBe(16_000);
    expect(backoffAfterFailure(anti, 20).waitMs).toBe(300_000);
  });
  it("auto-pauses at the configured threshold", () => {
    expect(backoffAfterFailure(anti, 3).autoPause).toBe(true);
    expect(backoffAfterFailure(anti, 2).autoPause).toBe(false);
  });
});

describe("recommendDelay / assessRisk", () => {
  it("recommends safe spacing for small batches", () => {
    expect(recommendDelay(3).riskLevel).toBe("safe");
  });
  it("escalates risk with group count", () => {
    expect(recommendDelay(100).riskLevel).toBe("dangerous");
  });
  it("flags a too-fast delay as risky", () => {
    const cfg: DelayConfig = { mode: "range", minSeconds: 10, maxSeconds: 20 };
    expect(assessRisk(cfg, 30).risky).toBe(true);
  });
  it("new accounts get safer minimums", () => {
    expect(recommendDelay(3, 5).minSeconds).toBeGreaterThanOrEqual(300);
  });
});

describe("estimateRunMs", () => {
  const range: DelayConfig = { mode: "range", minSeconds: 60, maxSeconds: 180 };
  const noBreak: SafetyBreakConfig = { enabled: false, everyNPosts: 25, durationSeconds: 300 };
  it("is zero for a single post (first is immediate)", () => {
    expect(estimateRunMs(1, range, noBreak)).toBe(0);
  });
  it("uses the average delay across gaps", () => {
    // 3 posts -> 2 gaps -> avg 120s each -> 240s
    expect(estimateRunMs(3, range, noBreak)).toBe(240_000);
  });
  it("adds safety-break time", () => {
    const brk: SafetyBreakConfig = { enabled: true, everyNPosts: 2, durationSeconds: 300 };
    // 5 posts -> 4 gaps*120s=480s + floor(5/2)=2 breaks*300s=600s -> 1080s
    expect(estimateRunMs(5, range, brk)).toBe(1_080_000);
  });
});

describe("daily budget", () => {
  it("is Infinity when unlimited", () => {
    expect(dailyBudgetRemaining(anti, 100)).toBe(Infinity);
  });
  it("counts down from the configured budget", () => {
    expect(dailyBudgetRemaining({ ...anti, dailyBudgetPerAccount: 50 }, 20)).toBe(30);
    expect(dailyBudgetRemaining({ ...anti, dailyBudgetPerAccount: 50 }, 60)).toBe(0);
  });
  it("dayKey is a stable YYYY-MM-DD", () => {
    expect(dayKey(Date.UTC(2026, 7, 20, 12))).toBe("2026-08-20");
  });
});
