/** Delay configuration between posts. */
export type DelayMode = "range" | "fixed";

export interface DelayConfig {
  mode: DelayMode;
  /** Seconds. For "fixed", min === max. */
  minSeconds: number;
  maxSeconds: number;
}

/** Safety-break: pause automatically after every N posts for M seconds. */
export interface SafetyBreakConfig {
  enabled: boolean;
  everyNPosts: number;
  durationSeconds: number;
}

/** Anti-detection knobs applied on top of DelayConfig. */
export interface AntiDetectionConfig {
  /** Add human-like jitter to each computed delay. */
  jitter: boolean;
  /** Ramp delays down as a run warms up (start slower, ease in). */
  warmup: boolean;
  /** Max posts per account per calendar day (0 = unlimited). */
  dailyBudgetPerAccount: number;
  /** After this many consecutive failures, auto-pause the run. */
  autoPauseAfterConsecutiveFailures: number;
}

/** Risk assessment for a proposed delay vs group count. */
export type RiskLevel = "safe" | "moderate" | "risky" | "dangerous";

export interface DelayRecommendation {
  minSeconds: number;
  maxSeconds: number;
  riskLevel: RiskLevel;
  reason: string;
}
