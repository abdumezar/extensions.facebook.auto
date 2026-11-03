import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunSnapshot } from "@nashir/shared";
import { CooldownNotice, cooldownAction } from "./CooldownNotice.js";

/**
 * Translations are absent under test, so react-i18next echoes the key. That makes
 * these assertions about WHICH string was chosen rather than about its wording, which
 * is the part that can actually be wrong.
 */

const NOW = 1_800_000_000_000;

function snap(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run_1",
    status: "cooldown",
    total: 50,
    done: 27,
    published: 27,
    pending: 0,
    failed: 0,
    nextWakeAt: NOW,
    activeAccountId: null,
    cooldownUntil: NOW + 15 * 60_000,
    cooldownClass: "rate_limit",
    cooldownReason: "there have been too many calls from this app",
    requiresOperator: false,
    ...over,
  };
}

describe("CooldownNotice", () => {
  it("tells the operator the queue is intact and how much is left", () => {
    render(<CooldownNotice snap={snap()} now={NOW} />);
    // 50 total, 27 done — the 23 that have not been posted are not lost.
    expect(screen.getByText(/throttle.heldForYou/)).toBeInTheDocument();
  });

  it("counts down to the earliest safe resume", () => {
    render(<CooldownNotice snap={snap()} now={NOW} />);
    expect(screen.getByText(/throttle.resumesIn/)).toBeInTheDocument();
    expect(screen.queryByText(/throttle.readyToResume/)).not.toBeInTheDocument();
  });

  it("says so once the wait is over", () => {
    render(<CooldownNotice snap={snap()} now={NOW + 16 * 60_000} />);
    expect(screen.getByText(/throttle.readyToResume/)).toBeInTheDocument();
  });

  it("names the reason Facebook gave, not a generic failure", () => {
    render(<CooldownNotice snap={snap({ cooldownClass: "policy_block" })} now={NOW} />);
    expect(screen.getByText("throttle.reason_policy_block")).toBeInTheDocument();
  });

  it("sends the user to Facebook for a checkpoint instead of showing a countdown", () => {
    render(
      <CooldownNotice snap={snap({ cooldownClass: "checkpoint", requiresOperator: true })} now={NOW} />,
    );
    expect(screen.getByText("throttle.checkpointAction")).toBeInTheDocument();
    expect(screen.queryByText(/throttle.resumesIn/)).not.toBeInTheDocument();
    expect(screen.queryByText(/throttle.readyToResume/)).not.toBeInTheDocument();
  });
});

describe("cooldownAction", () => {
  it("offers nothing but an override while the block is live", () => {
    expect(cooldownAction(snap(), NOW)).toBe("force");
  });

  it("offers a plain resume once the wait is genuinely over", () => {
    expect(cooldownAction(snap(), NOW + 16 * 60_000)).toBe("resume");
  });

  it("offers neither resume nor force for a checkpoint — no wait or override clears one", () => {
    // It used to return "none", which rendered no button at all and left the extension
    // locked with no way out once Facebook asked for a security check.
    expect(cooldownAction(snap({ requiresOperator: true }), NOW + 48 * 3_600_000)).toBe(
      "checkpoint",
    );
    expect(cooldownAction(snap({ requiresOperator: true }), NOW)).toBe("checkpoint");
  });

  it("has nothing to say about a run that is not cooling down", () => {
    expect(cooldownAction(snap({ status: "running" }), NOW)).toBe("none");
  });
});
