import { describe, expect, it } from "vitest";
import { ActivityTracker, busyState } from "./activity.js";

const idle = { run: async () => null, ramp: async () => null };

describe("ActivityTracker", () => {
  it("is active exactly while the tracked work is pending", async () => {
    const tracker = new ActivityTracker();
    let finish!: () => void;
    const work = tracker.track("radar", () => new Promise<void>((resolve) => (finish = resolve)));

    expect(tracker.active()).toBe("radar");
    finish();
    await work;
    expect(tracker.active()).toBeNull();
  });

  it("clears the entry when the work throws, and rethrows", async () => {
    const tracker = new ActivityTracker();
    await expect(
      tracker.track("engagement", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(tracker.active()).toBeNull();
  });

  it("stays active until the last overlapping run finishes", async () => {
    const tracker = new ActivityTracker();
    const finishers: Array<() => void> = [];
    const wait = () => new Promise<void>((resolve) => finishers.push(resolve));
    const first = tracker.track("radar", wait);
    const second = tracker.track("radar", wait);

    finishers[0]!();
    await first;
    expect(tracker.active()).toBe("radar");
    finishers[1]!();
    await second;
    expect(tracker.active()).toBeNull();
  });
});

describe("busyState", () => {
  it("is idle when nothing runs", async () => {
    expect(await busyState({ ...idle, tracker: new ActivityTracker() })).toEqual({ busy: false });
  });

  it.each(["running", "safety_break"] as const)("is busy for a campaign that is %s", async (status) => {
    const state = await busyState({ ...idle, run: async () => ({ status }), tracker: new ActivityTracker() });
    expect(state).toEqual({ busy: true, reason: "campaign" });
  });

  it.each(["cooldown", "paused", "completed", "idle"])("is not busy for a campaign that is %s", async (status) => {
    const state = await busyState({ ...idle, run: async () => ({ status }), tracker: new ActivityTracker() });
    expect(state.busy).toBe(false);
  });

  it("is busy while a rate ramp is running, but not once it has finished", async () => {
    const running = await busyState({ ...idle, ramp: async () => ({ status: "running" }), tracker: new ActivityTracker() });
    expect(running).toEqual({ busy: true, reason: "ramp" });
    const done = await busyState({ ...idle, ramp: async () => ({ status: "completed" }), tracker: new ActivityTracker() });
    expect(done.busy).toBe(false);
  });

  it("is busy while a Lead Radar sweep or an engagement read is in flight", async () => {
    const tracker = new ActivityTracker();
    void tracker.track("radar", () => new Promise<void>(() => {}));
    expect(await busyState({ ...idle, tracker })).toEqual({ busy: true, reason: "radar" });
  });

  it("ignores a saved extraction status: only a walk running right now counts", async () => {
    // A walk that died with the service worker leaves "reactors" saved for good.
    // The record is not even an input any more; busyState cannot see it.
    expect(await busyState({ ...idle, tracker: new ActivityTracker() })).toEqual({ busy: false });
  });

  it("is busy for a tracked extraction until it settles, also when it fails", async () => {
    const tracker = new ActivityTracker();
    let fail!: (error: Error) => void;
    const walk = tracker.track("extraction", () => new Promise<void>((_, reject) => (fail = reject)));
    expect(await busyState({ ...idle, tracker })).toEqual({ busy: true, reason: "extraction" });

    fail(new Error("Facebook said no"));
    await expect(walk).rejects.toThrow("Facebook said no");
    expect(await busyState({ ...idle, tracker })).toEqual({ busy: false });
  });

  it.each(["extraction", "groups"] as const)("is busy while a tracked %s job is in flight", async (reason) => {
    const tracker = new ActivityTracker();
    void tracker.track(reason, () => new Promise<void>(() => {}));
    expect(await busyState({ ...idle, tracker })).toEqual({ busy: true, reason });
  });

  it("reports busy when the run state cannot be read: an update must not guess", async () => {
    const state = await busyState({
      ...idle,
      run: async () => {
        throw new Error("storage unavailable");
      },
      tracker: new ActivityTracker(),
    });
    expect(state.busy).toBe(true);
  });
});
