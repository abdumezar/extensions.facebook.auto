import type { BusyReason, BusyState } from "@nashir/shared";

/**
 * Counts the unattended jobs that have no persisted "running" flag of their own: a Lead
 * Radar sweep and an engagement read are a few requests inside one alarm wake, and
 * reloading the extension in the middle of one would cut it off.
 */
export class ActivityTracker {
  private readonly pending = new Map<BusyReason, number>();

  /** Runs `work`, counted as `reason` until it settles. */
  async track<T>(reason: BusyReason, work: () => Promise<T>): Promise<T> {
    this.pending.set(reason, (this.pending.get(reason) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.pending.get(reason) ?? 1) - 1;
      if (left > 0) this.pending.set(reason, left);
      else this.pending.delete(reason);
    }
  }

  /** What is in flight right now, if anything. */
  active(): BusyReason | null {
    return this.pending.keys().next().value ?? null;
  }
}

interface BusyInputs {
  /** The campaign run record, if there is one. */
  run: () => Promise<{ status: string } | null | undefined>;
  /** The rate ramp record, if there is one. */
  ramp: () => Promise<{ status: string } | null | undefined>;
  tracker: ActivityTracker;
}

/**
 * Whether anything is running that an update would interrupt: a campaign (also while it
 * waits out a safety break), a rate ramp, or a job tracked in memory: an audience
 * extraction, a group join or leave, a Lead Radar sweep or an engagement read. The saved
 * extraction status is deliberately not consulted: a walk that died with the browser
 * or the service worker leaves it saved forever, and an update would never be allowed.
 * When the state cannot be read the answer is "busy": the cost of waiting is a retry,
 * the cost of guessing wrong is a cut-off run.
 */
export async function busyState(inputs: BusyInputs): Promise<BusyState> {
  try {
    const run = await inputs.run();
    if (run?.status === "running" || run?.status === "safety_break") return { busy: true, reason: "campaign" };
    const ramp = await inputs.ramp();
    if (ramp?.status === "running") return { busy: true, reason: "ramp" };
  } catch {
    return { busy: true, reason: "campaign" };
  }
  const reason = inputs.tracker.active();
  return reason ? { busy: true, reason } : { busy: false };
}
