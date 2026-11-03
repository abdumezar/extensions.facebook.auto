import type { CooldownState, GovernorSnapshot } from "@nashir/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointBanner } from "./CheckpointBanner.js";

const rpc = vi.fn();
vi.mock("../lib/rpc.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
  call: (...args: unknown[]) => rpc(...args),
}));

// Without an i18next instance `t` returns the key, so assertions target keys.
afterEach(() => vi.clearAllMocks());

const cooldown = (over: Partial<CooldownState> = {}): CooldownState => ({
  since: 0,
  untilMs: 0,
  scope: "account",
  reason: "checkpoint",
  evidence: "Facebook needs you to confirm it is you before this can continue.",
  matchedSignal: "confirm it is you",
  consecutive: 1,
  requiresOperator: true,
  ...over,
});

const snapshot = (cd: CooldownState | null): GovernorSnapshot => ({
  cooldown: cd,
  callsLastMinute: 0,
  callsLastHour: 0,
  byClass: {},
  byAccount: {},
  lastThrottleAt: null,
});

/** Answer GET_GOVERNOR_SNAPSHOT with `cd`, and RESOLVE_CHECKPOINT with `resolve`. */
function wire(cd: CooldownState | null, resolve?: Record<string, unknown>) {
  rpc.mockImplementation(async (req: { type: string }) => {
    if (req.type === "GET_GOVERNOR_SNAPSHOT") return { ok: true, data: snapshot(cd) };
    if (req.type === "RESOLVE_CHECKPOINT") {
      if (resolve?.["cleared"]) cd = null;
      return { ok: true, data: resolve ?? { cleared: false, health: "checkpoint", needsTab: false } };
    }
    return { ok: true };
  });
}

describe("CheckpointBanner", () => {
  it("shows nothing when there is no cooldown", async () => {
    wire(null);
    const { container } = render(<CheckpointBanner />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing for a cooldown a person cannot clear", async () => {
    // A rate limit has a clock and its own UI; this banner is only for the kind of
    // block that needs a human.
    wire(cooldown({ requiresOperator: false, reason: "rate_limit" }));
    const { container } = render(<CheckpointBanner />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a checkpoint with Facebook's own words", async () => {
    wire(cooldown());
    render(<CheckpointBanner />);
    expect(await screen.findByText("throttle.reason_checkpoint")).toBeInTheDocument();
    expect(screen.getByText(/confirm it is you/)).toBeInTheDocument();
  });

  it("says the block covers everything, not just a running campaign", async () => {
    // This is the whole reason the banner is in the shell: the governor gates group
    // loads and extraction too, and the old UI only offered a way out during a run.
    wire(cooldown());
    render(<CheckpointBanner />);
    expect(await screen.findByText("throttle.checkpointBlocksAll")).toBeInTheDocument();
  });

  it("offers a way to Facebook and a way to confirm, but no wait-it-out", async () => {
    wire(cooldown());
    render(<CheckpointBanner />);
    expect(await screen.findByText("throttle.checkpointOpen")).toBeInTheDocument();
    expect(screen.getByText("throttle.checkpointDone")).toBeInTheDocument();
    // A checkpoint has no clock, so neither of the rate-limit affordances applies.
    expect(screen.queryByText("throttle.resumeAnyway")).not.toBeInTheDocument();
    expect(screen.queryByText("common.resume")).not.toBeInTheDocument();
  });

  it("hides the override until a confirm has actually failed", async () => {
    wire(cooldown());
    render(<CheckpointBanner />);
    await screen.findByText("throttle.checkpointDone");
    expect(screen.queryByText("throttle.checkpointOverride")).not.toBeInTheDocument();
  });

  it("offers the override once our own probe says still-blocked", async () => {
    // The probe has been wrong twice. A tool must never be able to lock its own user
    // out permanently on the strength of its own guess.
    wire(cooldown(), { cleared: false, health: "checkpoint", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    expect(await screen.findByText("throttle.checkpointOverride")).toBeInTheDocument();
  });

  it("shows what the probe actually said, so a wrong answer is diagnosable", async () => {
    wire(cooldown(), { cleared: false, health: "checkpoint", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    expect(await screen.findByText(/\(checkpoint\)/)).toBeInTheDocument();
  });

  it("the override clears the hold outright", async () => {
    wire(cooldown(), { cleared: false, health: "checkpoint", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    await userEvent.click(await screen.findByText("throttle.checkpointOverride"));
    const types = rpc.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("CLEAR_COOLDOWN");
  });

  it("does not offer the override when the problem is just a missing tab", async () => {
    wire(cooldown(), { cleared: false, health: "unknown", needsTab: true });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    await screen.findByText("throttle.checkpointNoTab");
    expect(screen.queryByText("throttle.checkpointOverride")).not.toBeInTheDocument();
  });

  it("keeps the banner up when Facebook is still asking", async () => {
    wire(cooldown(), { cleared: false, health: "checkpoint", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    // The message now carries the probe's answer, so match on the prefix.
    expect(await screen.findByText(/throttle\.checkpointStill/)).toBeInTheDocument();
    expect(screen.getByText("throttle.reason_checkpoint")).toBeInTheDocument();
  });

  it("asks for a Facebook tab when there is none to read", async () => {
    wire(cooldown(), { cleared: false, health: "unknown", needsTab: true });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    expect(await screen.findByText("throttle.checkpointNoTab")).toBeInTheDocument();
  });

  it("clears itself once the check is genuinely gone", async () => {
    wire(cooldown(), { cleared: true, health: "ok", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    await waitFor(() =>
      expect(screen.queryByText("throttle.reason_checkpoint")).not.toBeInTheDocument(),
    );
  });

  it("verifies rather than clearing on trust", async () => {
    wire(cooldown(), { cleared: true, health: "ok", needsTab: false });
    render(<CheckpointBanner />);
    await userEvent.click(await screen.findByText("throttle.checkpointDone"));
    // It must ask the service worker to check, never send a bare CLEAR_COOLDOWN.
    const types = rpc.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("RESOLVE_CHECKPOINT");
    expect(types).not.toContain("CLEAR_COOLDOWN");
  });
});
