import type { PostJob, PostResult } from "./post.js";
import type { ThrottleClass } from "./governor.js";

export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  /** Our own pacing policy stopped the run for a while. */
  | "safety_break"
  /**
   * Facebook told us to stop.
   *
   * Distinct from every neighbour on purpose. `paused` means the operator stopped it,
   * `safety_break` means our own policy did, `error` means something broke. None of
   * them says "nothing is wrong, Facebook has asked us to wait, and the queue is
   * intact" — and conflating them loses either the intact queue or the fact that this
   * is normal, expected behaviour rather than a fault.
   */
  | "cooldown"
  | "done"
  | "error";

/**
 * The single source of truth for an in-flight campaign run.
 * Fully persisted after every mutation so the alarm-driven loop survives
 * service worker eviction. `tick()` is idempotent and re-entrancy-locked by runId.
 */
export interface RunState {
  runId: string;
  campaignId: string;
  campaignName: string;
  status: RunStatus;

  /** The expanded work queue (accounts x groups x variation-cycled captions). */
  queue: PostJob[];
  /** Index of the next job to process. */
  cursor: number;

  /** Epoch millis the next tick should act at (delay / safety-break gating). */
  nextWakeAt: number;

  /** Posts completed since the last safety break. */
  postsSinceBreak: number;
  /** Consecutive failures (drives backoff / auto-pause). */
  consecutiveFailures: number;
  /** Per-account completed counts within this run. */
  perAccountCounts: Record<string, number>;

  /** The account currently swapped-in (so we only swap when it changes). */
  activeAccountId: string | null;

  /** Results, parallel to processed queue entries. */
  results: PostResult[];

  /** Re-entrancy guard: set while a tick is executing. */
  locked: boolean;

  /**
   * Cooldown detail while `status === "cooldown"`. All optional so a RunState
   * persisted by an older build still deserialises.
   */
  cooldownUntil?: number;
  /** Facebook's own words, so the operator reads what Facebook actually said. */
  cooldownReason?: string;
  cooldownClass?: ThrottleClass;
  /** A checkpoint has no timer — only a person in a Facebook tab can clear it. */
  requiresOperator?: boolean;
  /** How many times this job has been deferred by a throttle. Guards a stuck run. */
  throttleDeferrals?: number;
  /**
   * Attempts already spent on the job at `cursor`. A transient failure re-tries the
   * same job on a later alarm rather than inside the tick, so this has to survive the
   * service worker being evicted in between.
   */
  jobAttempts?: number;

  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Human-facing error if status === 'error'. */
  errorMessage?: string;
}

/** Lightweight live view the dashboard subscribes to. */
export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  total: number;
  done: number;
  published: number;
  pending: number;
  failed: number;
  lastGroupName?: string;
  nextWakeAt: number;
  activeAccountId: string | null;
  /** Mirrors the RunState fields above so the dashboard's existing poll can show them. */
  cooldownUntil?: number;
  cooldownReason?: string;
  cooldownClass?: ThrottleClass;
  requiresOperator?: boolean;
  /** The auto-pause reason, which used to be recorded and then never shown. */
  errorMessage?: string;
}
