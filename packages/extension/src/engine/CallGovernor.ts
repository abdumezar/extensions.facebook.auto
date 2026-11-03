import type {
  BudgetDomain,
  CallBudgetConfig,
  CooldownState,
  EndpointClass,
  GovernorSnapshot,
  GovernorVerdict,
  ThrottleClass,
  ThrottleVerdict,
} from "@nashir/shared";
import type { ClockPort, LoggerPort, StoragePort } from "./ports/index.js";
import {
  DEFAULT_CALL_BUDGET,
  type GovernorRing,
  advance,
  budgetVerdict,
  countsFor,
  emptyRing,
  isMutation,
  nextCooldownMs,
  opensCooldown,
  recordCall,
  withBudgetOverrides,
} from "./governorMath.js";

export const GOVERNOR_KEY = "nashir:governor:v1";

/**
 * Thrown when a call must not be made: a cooldown is live, or the wait to make it
 * would outlast the service worker.
 *
 * Deliberately an error rather than a silent delay. Facebook's guidance is to stop
 * calling during a block, so the governor's job is to *refuse*, and a refusal that
 * looked like a slow success would be indistinguishable from working.
 */
export class ThrottledError extends Error {
  override readonly name = "ThrottledError";

  constructor(
    readonly reason: NonNullable<GovernorVerdict["reason"]>,
    /** When the call could be tried again, or undefined when only a person can clear it. */
    readonly retryAtMs: number | undefined,
    readonly cooldown: CooldownState | null,
    message: string,
  ) {
    super(message);
  }

  get throttleClass(): ThrottleClass | null {
    return this.cooldown?.reason ?? null;
  }

  get requiresOperator(): boolean {
    return this.cooldown?.requiresOperator ?? false;
  }

  /**
   * The verdict this refusal represents, or null when it was only pacing.
   *
   * A pacing hold is a few hundred milliseconds of politeness; a cooldown is Facebook
   * telling us to stop. Callers must be able to tell them apart, because one is worth
   * pausing a campaign over and the other is not.
   */
  toVerdict(): ThrottleVerdict | null {
    const cd = this.cooldown;
    if (!cd) return null;
    return {
      class: cd.reason,
      scope: cd.scope,
      evidence: cd.evidence,
      matchedSignal: cd.matchedSignal,
    };
  }
}

/**
 * CallGovernor — one place that knows how many calls this install has made to
 * Facebook, and whether it is allowed to make another.
 *
 * Facebook counts calls per caller, summed across every subsystem, so per-subsystem
 * politeness does not add up to a polite app: three services each backing off their
 * own calls still burst collectively, because none of them knows the others exist.
 * This is the thing that knows.
 *
 * Every byte of that knowledge is persisted. MV3 evicts the service worker after ~30
 * seconds idle, and an in-memory counter is a counter that is always zero — which is
 * precisely the bug that produced the incident this class exists to prevent.
 */
export class CallGovernor {
  private ring: GovernorRing | null = null;
  /** Serialises mutations. One service worker at a time, so in-memory is sufficient. */
  private mutationChain: Promise<unknown> = Promise.resolve();
  private cfg: CallBudgetConfig;

  constructor(
    private readonly storage: StoragePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    cfg: CallBudgetConfig = DEFAULT_CALL_BUDGET,
    private readonly rand: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.cfg = cfg;
  }

  /** Apply recipe-supplied budget overrides, so limits can be tightened with a recipe change. */
  applyBudget(over?: Partial<CallBudgetConfig>): void {
    this.cfg = withBudgetOverrides(DEFAULT_CALL_BUDGET, over);
  }

  /**
   * Narrow the hourly ceiling to what the rate ramp actually measured.
   *
   * Only ever downward. A measurement taken against one throwaway account on one day
   * is evidence that we can go no faster, never permission to go faster than the
   * shipped default — that default is the conservative floor and stays the floor.
   *
   * This is also where the ramp's text-post measurement stops being unsafe for media
   * campaigns: it is applied to the *call* budget, which a video post spends twenty
   * times over, rather than to a posting cadence that would ignore the difference.
   */
  applyMeasured(measured: { callBudgetPerHour: number } | null | undefined): void {
    const measuredHour = measured?.callBudgetPerHour;
    if (!measuredHour || measuredHour <= 0) return;
    const www = this.cfg.perDomain.www;
    const perHour = Math.min(www.perHour, Math.round(measuredHour));
    if (perHour === www.perHour) return;
    this.cfg = {
      ...this.cfg,
      perDomain: {
        ...this.cfg.perDomain,
        www: { perMinute: Math.min(www.perMinute, perHour), perHour },
      },
    };
    this.logger.info("Call budget narrowed to the measured ceiling", {
      perHour,
      measuredHour,
    });
  }

  get budget(): CallBudgetConfig {
    return this.cfg;
  }

  // ---------------------------------------------------------------- state

  private async load(): Promise<GovernorRing> {
    if (!this.ring) {
      const stored = await this.storage.get<GovernorRing>(GOVERNOR_KEY);
      this.ring = stored?.version === 1 ? stored : emptyRing(this.clock.now());
    }
    return advance(this.ring, this.clock.now());
  }

  private async persist(): Promise<void> {
    if (this.ring) await this.storage.set(GOVERNOR_KEY, this.ring);
  }

  /** The live cooldown, or null. Cheap enough for any caller to ask before working. */
  async cooldown(): Promise<CooldownState | null> {
    const ring = await this.load();
    const cd = ring.cooldown;
    if (!cd) return null;
    if (!cd.requiresOperator && this.clock.now() >= cd.untilMs) return null;
    return cd;
  }

  async snapshot(): Promise<GovernorSnapshot> {
    const ring = await this.load();
    const byClass: Partial<Record<EndpointClass, number>> = {};
    for (const [cls, slots] of Object.entries(ring.byClass)) {
      const n = (slots ?? []).reduce((a, b) => a + b, 0);
      if (n > 0) byClass[cls as EndpointClass] = n;
    }
    const byAccount: Record<string, number> = {};
    for (const [id, slots] of Object.entries(ring.byAccount)) {
      const n = slots.reduce((a, b) => a + b, 0);
      if (n > 0) byAccount[id] = n;
    }
    const www = countsFor(ring, "www");
    const upload = countsFor(ring, "upload");
    return {
      cooldown: await this.cooldown(),
      callsLastMinute: www.minute + upload.minute,
      callsLastHour: www.hour + upload.hour,
      byClass,
      byAccount,
      lastThrottleAt: ring.lastThrottleAt,
    };
  }

  /**
   * Lift a cooldown early. Only ever called from an explicit operator action, and the
   * UI puts a warning in front of it: calling Facebook again during a block is the
   * documented way to make the block longer.
   */
  async clearCooldown(): Promise<void> {
    const ring = await this.load();
    if (!ring.cooldown) return;
    this.logger.warn("Cooldown cleared by the operator", {
      reason: ring.cooldown.reason,
      remainingMs: Math.max(0, ring.cooldown.untilMs - this.clock.now()),
    });
    ring.cooldown = null;
    ring.cleanSince = this.clock.now();
    await this.persist();
  }

  // ---------------------------------------------------------------- asking

  /** Would a call be allowed right now? Side-effect free — asking costs no budget. */
  async check(
    domain: BudgetDomain,
    cls: EndpointClass,
    accountId?: string,
  ): Promise<GovernorVerdict> {
    const ring = await this.load();
    return budgetVerdict(
      ring,
      domain,
      cls,
      accountId,
      this.clock.now(),
      this.cfg,
      this.rand,
      ring.pressure ?? undefined,
    );
  }

  /**
   * Take a slot for one call, waiting for it if the wait is short.
   *
   * Throws `ThrottledError` rather than waiting when a cooldown is live or the wait
   * would outlast the service worker. Callers with an alarm reschedule; callers without simply
   * skip. Nothing sleeps for minutes: the service worker would be evicted and the call lost.
   */
  async acquire(domain: BudgetDomain, cls: EndpointClass, accountId?: string): Promise<void> {
    if (!isMutation(cls)) return this.take(domain, cls, accountId);

    // Mutations run one at a time, whatever else is in flight. Chained rather than
    // locked so a thrown ThrottledError cannot wedge the queue.
    const run = this.mutationChain.then(
      () => this.take(domain, cls, accountId),
      () => this.take(domain, cls, accountId),
    );
    this.mutationChain = run.catch(() => undefined);
    return run;
  }

  private async take(
    domain: BudgetDomain,
    cls: EndpointClass,
    accountId: string | undefined,
  ): Promise<void> {
    // Bounded: each pass either consumes its wait or refuses. The cap only guards
    // against a pathological clock, never normal operation.
    for (let attempt = 0; attempt < 4; attempt++) {
      const ring = await this.load();
      const verdict = budgetVerdict(
        ring,
        domain,
        cls,
        accountId,
        this.clock.now(),
        this.cfg,
        this.rand,
        ring.pressure ?? undefined,
      );

      if (verdict.allowed) {
        recordCall(ring, domain, cls, accountId, this.clock.now());
        await this.persist();
        return;
      }

      if (verdict.reason === "cooldown" || verdict.waitMs > this.cfg.maxSyncWaitMs) {
        throw new ThrottledError(
          verdict.reason ?? "cooldown",
          verdict.retryAtMs,
          verdict.cooldown ?? null,
          this.refusalMessage(verdict, cls),
        );
      }

      await this.sleep(verdict.waitMs);
    }

    throw new ThrottledError("spacing", this.clock.now() + 1000, null, "Could not get a slot.");
  }

  private refusalMessage(v: GovernorVerdict, cls: EndpointClass): string {
    if (v.reason === "cooldown" && v.cooldown) {
      return v.cooldown.requiresOperator
        ? "Facebook needs you to confirm it is you before this can continue."
        : "Facebook asked us to pause. Nothing will be sent until the cooldown ends.";
    }
    const secs = Math.ceil(v.waitMs / 1000);
    return `Holding ${cls} for ${secs}s to stay inside Facebook's call budget.`;
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Record what Facebook said about a call that has already gone out.
   *
   * A throttling verdict opens a cooldown; a clean one eventually walks the ladder
   * back down. `pressure` is remembered rather than used once, so a widened pace
   * persists past the single response that carried the header.
   */
  async report(verdict: ThrottleVerdict, accountId?: string): Promise<void> {
    const ring = await this.load();
    const now = this.clock.now();

    if (verdict.pressure != null) ring.pressure = verdict.pressure;

    if (!opensCooldown(verdict)) {
      // A clean run long enough to trust walks the ladder back to the bottom.
      if (ring.consecutiveThrottles > 0 && now - ring.cleanSince >= this.cfg.cooldownResetAfterCleanMs) {
        ring.consecutiveThrottles = 0;
      }
      await this.persist();
      return;
    }

    ring.consecutiveThrottles += 1;
    ring.cleanSince = now;
    ring.lastThrottleAt = now;

    const requiresOperator = verdict.class === "checkpoint";
    const waitMs = nextCooldownMs(
      ring.consecutiveThrottles,
      this.cfg,
      this.rand,
      verdict.retryAfterMs,
    );
    const cooldown: CooldownState = {
      since: now,
      untilMs: now + waitMs,
      scope: verdict.scope,
      accountId: verdict.scope === "account" ? accountId : undefined,
      reason: verdict.class,
      // Facebook's own words, capped. Never a request body — those carry fb_dtsg.
      evidence: (verdict.evidence ?? "").slice(0, 500),
      matchedSignal: verdict.matchedSignal ?? "",
      consecutive: ring.consecutiveThrottles,
      requiresOperator,
    };
    ring.cooldown = cooldown;
    await this.persist();

    // Loud, and carrying the verbatim message: when Facebook invents new throttle
    // copy, this log line is what lets it be added to the recipe without a repro.
    this.logger.error("Facebook asked us to stop", {
      class: verdict.class,
      scope: verdict.scope,
      matchedSignal: cooldown.matchedSignal,
      evidence: cooldown.evidence,
      consecutive: cooldown.consecutive,
      untilMs: cooldown.untilMs,
      requiresOperator,
      serverStatedWaitMs: verdict.retryAfterMs,
    });
  }
}
