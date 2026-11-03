import { describe, expect, it, vi } from "vitest";
import { handleUiRequest } from "./messageRouter.js";
import { ActivityTracker } from "./activity.js";

// The router reaches the container only through this seam; the container itself needs chrome.
const stub = vi.hoisted(() => ({
  c: null as unknown,
}));
vi.mock("./container.js", () => ({ container: () => stub.c }));

function wire(parts: {
  run?: { status: string } | null;
  ramp?: { status: string };
  extraction?: { status: string } | null;
  tracker?: ActivityTracker;
}) {
  stub.c = {
    engine: { getState: vi.fn(async () => parts.run ?? null) },
    feasibility: { get: vi.fn(async () => ({ ramp: parts.ramp })) },
    audience: { state: vi.fn(async () => parts.extraction ?? null) },
    activity: parts.tracker ?? new ActivityTracker(),
  };
}

describe("GET_BUSY_STATE", () => {
  it("is idle when nothing runs", async () => {
    wire({});
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({ ok: true, data: { busy: false } });
  });

  it("is busy for a running campaign", async () => {
    wire({ run: { status: "running" } });
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({
      ok: true,
      data: { busy: true, reason: "campaign" },
    });
  });

  it("is busy for a rate ramp", async () => {
    wire({ ramp: { status: "running" } });
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({ ok: true, data: { busy: true, reason: "ramp" } });
  });

  it("is not busy for a saved extraction status with no walk running", async () => {
    // A walk that died with the service worker leaves its status saved for good.
    wire({ extraction: { status: "reactors" } });
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({ ok: true, data: { busy: false } });
  });

  it("is busy for a tracked extraction, and not once it has failed", async () => {
    const tracker = new ActivityTracker();
    let fail!: (error: Error) => void;
    const walk = tracker.track("extraction", () => new Promise<void>((_, reject) => (fail = reject)));
    wire({ tracker });
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({
      ok: true,
      data: { busy: true, reason: "extraction" },
    });

    fail(new Error("gone"));
    await walk.catch(() => {});
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({ ok: true, data: { busy: false } });
  });

  it("is busy while a Lead Radar sweep is in flight", async () => {
    const tracker = new ActivityTracker();
    void tracker.track("radar", () => new Promise<void>(() => {}));
    wire({ tracker });
    expect(await handleUiRequest({ type: "GET_BUSY_STATE" })).toEqual({ ok: true, data: { busy: true, reason: "radar" } });
  });
});
