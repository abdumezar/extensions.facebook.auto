import { describe, it, expect } from "vitest";
import { DEFAULT_FB_RECIPE } from "@nashir/shared";
import { emptyRecord, gatePassed, isRateLimited, measuredDefaults, verdictFor } from "./feasibilityMath.js";

describe("verdictFor", () => {
  it("downgrades a check with a warning to partial rather than passing it silently", () => {
    expect(verdictFor([{ id: "a", status: "pass" }])).toBe("pass");
    expect(verdictFor([{ id: "a", status: "pass" }, { id: "b", status: "warn" }])).toBe("partial");
    expect(verdictFor([{ id: "a", status: "warn" }, { id: "b", status: "fail" }])).toBe("fail");
    expect(verdictFor([])).toBe("unrun");
  });

  it("does not let a skipped step count as a failure", () => {
    expect(verdictFor([{ id: "a", status: "pass" }, { id: "b", status: "skipped" }])).toBe("pass");
  });
});

describe("isRateLimited", () => {
  it("matches throttle wording case-insensitively", () => {
    expect(isRateLimited("You're Posting Too Frequently", DEFAULT_FB_RECIPE)).toBe(true);
    expect(isRateLimited("Please try again later", DEFAULT_FB_RECIPE)).toBe(true);
    expect(isRateLimited("Invalid group id", DEFAULT_FB_RECIPE)).toBe(false);
  });

  it("survives a recipe published before the field existed", () => {
    expect(isRateLimited("slow down", { ...DEFAULT_FB_RECIPE, rateLimitSignals: undefined })).toBe(false);
  });
});

describe("measuredDefaults", () => {
  it("derives a delay well below the measured ceiling", () => {
    const d = measuredDefaults(20);
    // 60% of 20/hour = 12/hour = one post every 300s, spread ±30%.
    expect(d.minSeconds).toBe(210);
    expect(d.maxSeconds).toBe(390);
    expect(d.dailyBudgetPerAccount).toBe(96);
    // The mean gap must be LONGER than the ceiling's own gap (3600/20 = 180s), or the
    // "safe" default would be posting at exactly the rate Facebook was last tolerating.
    expect((d.minSeconds + d.maxSeconds) / 2).toBeGreaterThan(3600 / 20);
  });

  it("keeps a sane floor for an absurdly low ceiling", () => {
    const d = measuredDefaults(1);
    expect(d.minSeconds).toBeGreaterThanOrEqual(15);
    expect(d.breakEveryNPosts).toBeGreaterThanOrEqual(5);
    expect(d.dailyBudgetPerAccount).toBeGreaterThanOrEqual(10);
  });

  it("stays conservative at a high ceiling instead of matching it", () => {
    const d = measuredDefaults(60);
    const meanGap = (d.minSeconds + d.maxSeconds) / 2;
    expect(3600 / meanGap).toBeLessThan(60);
  });
});

describe("gatePassed", () => {
  it("is false until all three checks have actually run", () => {
    const record = emptyRecord(0);
    expect(gatePassed(record)).toBe(false);

    record.checks.post.verdict = "pass";
    record.checks.swap.verdict = "partial";
    expect(gatePassed(record)).toBe(false);

    record.checks.ramp.verdict = "pass";
    expect(gatePassed(record)).toBe(true);
  });

  it("is false when any check failed", () => {
    const record = emptyRecord(0);
    record.checks.post.verdict = "pass";
    record.checks.swap.verdict = "fail";
    record.checks.ramp.verdict = "pass";
    expect(gatePassed(record)).toBe(false);
  });
});

describe("measuredDefaults states the ceiling in calls, not just posts", () => {
  it("reports the derated rate as a call budget", () => {
    // 30/hr measured, derated to 60% => 18 safe posts/hr, and the ramp posted text,
    // so 18 calls/hr is the number a mixed workload has to be held to.
    expect(measuredDefaults(30).callBudgetPerHour).toBe(18);
  });

  it("never reports a budget of zero, however slow the measurement", () => {
    expect(measuredDefaults(1).callBudgetPerHour).toBeGreaterThanOrEqual(1);
  });

  it("stays consistent with the posting cadence it recommends", () => {
    const d = measuredDefaults(60);
    const meanSeconds = (d.minSeconds + d.maxSeconds) / 2;
    // Roughly one post per mean gap, and one call per post while the ramp measured.
    expect(Math.round(3600 / meanSeconds)).toBeCloseTo(d.callBudgetPerHour, -1);
  });
});
