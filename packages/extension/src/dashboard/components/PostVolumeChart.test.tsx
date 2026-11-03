import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimePoint } from "@nashir/shared";
import { PostVolumeChart, PostVolumeTable } from "./PostVolumeChart.js";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function point(over: Partial<TimePoint> = {}): TimePoint {
  return { bucketStart: T0, published: 0, pending: 0, failed: 0, ...over };
}

/** Every drawn column segment, in document order. */
function segments(container: HTMLElement): SVGPathElement[] {
  return [...container.querySelectorAll("path")];
}

describe("PostVolumeChart", () => {
  const series = [
    point({ bucketStart: T0, published: 3, pending: 1, failed: 1 }),
    point({ bucketStart: T0 + HOUR }),
    point({ bucketStart: T0 + 2 * HOUR, published: 2 }),
  ];

  it("draws one segment per non-zero outcome and nothing for an empty bucket", () => {
    const { container } = render(<PostVolumeChart series={series} bucketMs={HOUR} />);
    // 3 for the first bucket, 0 for the empty one, 1 for the last.
    expect(segments(container)).toHaveLength(4);
  });

  it("keeps a bucket with no posts as a band, so the gap stays visible", () => {
    const { container } = render(<PostVolumeChart series={series} bucketMs={HOUR} />);
    expect(container.querySelectorAll("rect[role='button']")).toHaveLength(3);
  });

  it("names every outcome in the legend, so identity never rests on colour", () => {
    render(<PostVolumeChart series={series} bucketMs={HOUR} />);
    const legend = screen.getByRole("list");

    for (const key of ["published", "pending", "failed"]) {
      expect(within(legend).getByText(`analytics.status_${key}`)).toBeInTheDocument();
    }
    // Totals across the whole series, beside each name.
    expect(within(legend).getByText("5")).toBeInTheDocument();
  });

  it("exposes each bucket to the keyboard with its own numbers", () => {
    render(<PostVolumeChart series={series} bucketMs={HOUR} />);
    const bands = screen.getAllByRole("button");

    expect(bands).toHaveLength(3);
    for (const band of bands) expect(band).toHaveAttribute("tabindex", "0");
  });

  it("renders without a divide-by-zero when every bucket is empty", () => {
    const { container } = render(
      <PostVolumeChart series={[point(), point({ bucketStart: T0 + HOUR })]} bucketMs={HOUR} />,
    );

    expect(segments(container)).toHaveLength(0);
    for (const line of container.querySelectorAll("line")) {
      expect(Number(line.getAttribute("y1"))).not.toBeNaN();
    }
  });

  it("survives an empty series rather than throwing", () => {
    const { container } = render(<PostVolumeChart series={[]} bucketMs={HOUR} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("PostVolumeTable", () => {
  it("carries the same numbers as the chart, minus the empty buckets", () => {
    render(
      <PostVolumeTable
        series={[
          point({ published: 3, pending: 1, failed: 1 }),
          point({ bucketStart: T0 + HOUR }),
        ]}
        bucketMs={HOUR}
      />,
    );

    // One header row plus the single bucket that has data.
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "3" })).toBeInTheDocument();
  });

  it("says so plainly when the window holds nothing", () => {
    render(<PostVolumeTable series={[point()]} bucketMs={HOUR} />);
    expect(screen.getByText("analytics.empty")).toBeInTheDocument();
  });
});
