import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GovernorSnapshot } from "@nashir/shared";
import { GovernorCard } from "./GovernorCard.js";

const NOW = 1_800_000_000_000;

function snap(over: Partial<GovernorSnapshot> = {}): GovernorSnapshot {
  return {
    cooldown: null,
    callsLastMinute: 3,
    callsLastHour: 41,
    byClass: { "read.groups": 30, "mutation.post": 11 },
    byAccount: { "acct-a": 41 },
    lastThrottleAt: null,
    ...over,
  };
}

describe("GovernorCard", () => {
  it("answers the question the last incident could not: how many calls, and when", () => {
    render(<GovernorCard snap={snap()} now={NOW} />);
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("governor.clear")).toBeInTheDocument();
  });

  it("breaks the spend down by what it was spent on", () => {
    render(<GovernorCard snap={snap()} now={NOW} />);
    expect(screen.getByText("read.groups")).toBeInTheDocument();
    expect(screen.getByText("mutation.post")).toBeInTheDocument();
  });

  it("shows Facebook's verbatim words and which rule recognised them", () => {
    render(
      <GovernorCard
        snap={snap({
          cooldown: {
            since: NOW,
            untilMs: NOW + 15 * 60_000,
            scope: "global",
            reason: "rate_limit",
            evidence: "there have been too many calls from this app",
            matchedSignal: "code:4",
            consecutive: 1,
            requiresOperator: false,
          },
        })}
        now={NOW}
      />,
    );

    // Verbatim, so unrecognised copy can be added to the recipe from this alone.
    expect(screen.getByText(/too many calls from this app/)).toBeInTheDocument();
    expect(screen.getByText("code:4")).toBeInTheDocument();
    expect(screen.getByText("throttle.reason_rate_limit")).toBeInTheDocument();
    expect(screen.getByText(/throttle.resumesIn/)).toBeInTheDocument();
  });

  it("does not promise a countdown for a checkpoint", () => {
    render(
      <GovernorCard
        snap={snap({
          cooldown: {
            since: NOW,
            untilMs: NOW + 15 * 60_000,
            scope: "account",
            reason: "checkpoint",
            evidence: "confirm your identity",
            matchedSignal: "code:601",
            consecutive: 1,
            requiresOperator: true,
          },
        })}
        now={NOW}
      />,
    );

    expect(screen.getByText("throttle.checkpointAction")).toBeInTheDocument();
    expect(screen.queryByText(/throttle.resumesIn/)).not.toBeInTheDocument();
  });
});
