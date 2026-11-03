import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FeasibilityRecord, RampState, StepResult } from "@nashir/shared";
import { GateBanner, RampProgress, StepList } from "./FeasibilityPage.js";
import { emptyRecord } from "../../engine/feasibilityMath.js";

/**
 * These components are how an operator decides whether the gate passed. A step that
 * failed but reads as fine, or a ramp that was throttled but looks complete, would send
 * the whole project forward on a false result — so the rendering is worth asserting.
 *
 * Translations are absent under test (no i18next instance), so react-i18next echoes the
 * key. That is actually convenient: it makes the assertions about WHICH string was
 * chosen, not about its wording.
 */

const STEPS: StepResult[] = [
  { id: "session", status: "pass", evidence: { fbUserId: "100000000000001" }, latencyMs: 120 },
  { id: "tabs", status: "warn", detail: "3 facebook.com tabs open.", evidence: { count: 3 } },
  { id: "tokens", status: "pass", evidence: { dtsgLength: 14, hasLsd: true } },
  { id: "post", status: "fail", detail: "Sorry, something went wrong" },
  { id: "classify", status: "skipped" },
];

describe("StepList", () => {
  it("renders every step, including the skipped ones", () => {
    render(<StepList steps={STEPS} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("shows Facebook's own error text rather than paraphrasing it", () => {
    render(<StepList steps={STEPS} />);
    expect(screen.getByText("Sorry, something went wrong")).toBeInTheDocument();
  });

  it("never displays a token value, only its measured length", () => {
    render(<StepList steps={STEPS} />);
    expect(screen.getByText("dtsgLength")).toBeInTheDocument();
    expect(screen.queryByText(/dtsg_/)).not.toBeInTheDocument();
  });

  it("drops evidence that carries no information rather than printing 'false'", () => {
    render(<StepList steps={[{ id: "x", status: "pass", evidence: { skipped: false, name: "" } }]} />);
    expect(screen.queryByText("skipped")).not.toBeInTheDocument();
    expect(screen.queryByText("name")).not.toBeInTheDocument();
  });

  it("renders a permalink as a link, not as a wall of URL", () => {
    render(
      <StepList
        steps={[{ id: "post", status: "pass", evidence: { permalink: "https://www.facebook.com/groups/1/permalink/2/" } }]}
      />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://www.facebook.com/groups/1/permalink/2/");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("prints the rewritten origin and referer rather than hiding them behind a link", () => {
    // These two URLs ARE the evidence for the header-rewrite step — collapsing them to an
    // icon, as the permalink does, would remove the only thing that step records.
    render(
      <StepList
        steps={[
          {
            id: "dnr",
            status: "pass",
            evidence: { rules: 4, origin: "https://www.facebook.com", referer: "https://www.facebook.com/" },
          },
        ]}
      />,
    );
    expect(screen.getByText("https://www.facebook.com")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("GateBanner", () => {
  it("counts only the checks that actually ran", () => {
    const record: FeasibilityRecord = emptyRecord(0);
    record.checks.post.verdict = "pass";
    render(<GateBanner record={record} passed={false} />);

    // The i18n key echoes with its interpolation, so the count is visible in the output.
    expect(screen.getByText(/feasibility.gateOpen/)).toBeInTheDocument();
    expect(screen.queryByText("feasibility.gatePassed")).not.toBeInTheDocument();
  });

  it("says the gate passed only when told so", () => {
    render(<GateBanner record={emptyRecord(0)} passed />);
    expect(screen.getByText("feasibility.gatePassed")).toBeInTheDocument();
  });

  it("always carries the real-posts warning, passed or not", () => {
    render(<GateBanner record={emptyRecord(0)} passed />);
    expect(screen.getByText("feasibility.warning")).toBeInTheDocument();
  });
});

function ramp(over: Partial<RampState> = {}): RampState {
  return {
    config: {
      accountId: "acc_a",
      groupIds: ["g1"],
      message: "m",
      tiers: [{ postsPerHour: 12, posts: 2 }],
      cap: 10,
    },
    status: "throttled",
    tierIndex: 1,
    postsInTier: 0,
    postsDone: 3,
    startedAt: 1_700_000_000_000,
    posts: [
      { at: 1_700_000_000_000, tierPostsPerHour: 12, groupId: "g1", status: "published", throttled: false },
      {
        at: 1_700_000_300_000,
        tierPostsPerHour: 30,
        groupId: "g1",
        status: "failed",
        error: "You're posting too frequently",
        throttled: true,
      },
    ],
    ceilingPostsPerHour: 12,
    ...over,
  };
}

describe("RampProgress", () => {
  it("marks the throttled post distinctly from an ordinary failure", () => {
    render(<RampProgress ramp={ramp()} />);
    expect(screen.getByText("feasibility.throttled")).toBeInTheDocument();
    // The unthrottled row still shows its raw Facebook status.
    expect(screen.getByText("published")).toBeInTheDocument();
  });

  it("surfaces the ceiling, which is the number the whole check exists to produce", () => {
    render(<RampProgress ramp={ramp()} />);
    expect(screen.getByText(/feasibility.ceiling/)).toBeInTheDocument();
  });

  it("shows no ceiling chip when no tier survived", () => {
    render(<RampProgress ramp={ramp({ ceilingPostsPerHour: undefined })} />);
    expect(screen.queryByText(/feasibility.ceiling/)).not.toBeInTheDocument();
  });

  it("names the outcome when the ramp is over, and the next wake while it runs", () => {
    const { rerender } = render(<RampProgress ramp={ramp()} />);
    expect(screen.getByText("feasibility.rampStatus_throttled")).toBeInTheDocument();

    rerender(<RampProgress ramp={ramp({ status: "running", nextWakeAt: 1_700_000_600_000 })} />);
    expect(screen.queryByText("feasibility.rampStatus_throttled")).not.toBeInTheDocument();
    expect(screen.getByText(/feasibility.nextPost/)).toBeInTheDocument();
  });

  it("lists one row per post attempt", () => {
    render(<RampProgress ramp={ramp()} />);
    const body = screen.getByRole("table").querySelector("tbody")!;
    expect(within(body).getAllByRole("row")).toHaveLength(2);
  });
});
