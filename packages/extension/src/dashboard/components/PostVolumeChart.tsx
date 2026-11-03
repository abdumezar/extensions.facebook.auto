import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TimePoint } from "@nashir/shared";
import { cn } from "../ui/index.js";

/** Bottom-to-top stack order. Fixed: the colour follows the outcome, never its size. */
const SERIES = [
  { key: "published", fill: "fill-chart-published", swatch: "bg-chart-published" },
  { key: "pending", fill: "fill-chart-pending", swatch: "bg-chart-pending" },
  { key: "failed", fill: "fill-chart-failed", swatch: "bg-chart-failed" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

// Drawn in a fixed coordinate space and scaled by the browser, so one viewBox covers
// every container width without a resize observer.
const VB = { w: 720, h: 214 };
// No bottom band: the x-axis labels are HTML, not SVG text (see the axis row below).
const PAD = { top: 14, right: 8, bottom: 4, left: 40 };
const PLOT = { w: VB.w - PAD.left - PAD.right, h: VB.h - PAD.top - PAD.bottom };
const MAX_BAR = 24;
/** The surface gap that separates stacked segments — never a stroke. */
const GAP = 2;
const RADIUS = 4;

export interface PostVolumeChartProps {
  series: TimePoint[];
  /** Bucket width, which is what decides whether a tick reads as a time or a date. */
  bucketMs: number;
  className?: string;
}

/**
 * Post outcomes over time, as a stacked column per time bucket.
 *
 * Time runs left→right even under RTL: the plot is deliberately `dir="ltr"`, because a
 * mirrored time axis is not a convention Arabic readers expect from a chart — only the
 * surrounding prose flips. Every value is also in `PostVolumeTable`, so nothing here is
 * reachable by hover alone.
 */
export function PostVolumeChart({ series, bucketMs, className }: PostVolumeChartProps) {
  const { t, i18n } = useTranslation();
  const [active, setActive] = useState<number | null>(null);

  const fmt = useMemo(() => bucketFormatter(i18n.language, bucketMs), [i18n.language, bucketMs]);
  const totals = useMemo(() => series.map((p) => p.published + p.pending + p.failed), [series]);

  const axisMax = niceCeil(Math.max(1, ...totals));
  const band = series.length > 0 ? PLOT.w / series.length : PLOT.w;
  const barWidth = Math.max(3, Math.min(MAX_BAR, band - 6));

  const seriesTotals: Record<SeriesKey, number> = {
    published: sum(series, "published"),
    pending: sum(series, "pending"),
    failed: sum(series, "failed"),
  };

  const y = (value: number) => PAD.top + PLOT.h - (value / axisMax) * PLOT.h;
  // niceCeil keeps the max even, so the midline is always a whole number of posts.
  const ticks = [0, axisMax / 2, axisMax];
  const activePoint = active != null ? series[active] : undefined;

  return (
    <div className={cn("relative", className)}>
      {/* LTR even under RTL — see the note above. */}
      <div dir="ltr">
        <svg
          viewBox={`0 0 ${VB.w} ${VB.h}`}
          className="w-full"
          role="img"
          aria-label={t("analytics.chartAlt", {
            published: seriesTotals.published,
            pending: seriesTotals.pending,
            failed: seriesTotals.failed,
          })}
        >
          {/* Hairline, solid, one step off the surface — the grid is never the loud part. */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={VB.w - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-outline-variant"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-on-surface-variant text-[11px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          ))}

          {series.map((point, i) => {
            const x = PAD.left + i * band + (band - barWidth) / 2;
            return (
              <g key={point.bucketStart}>
                {stack(point).map((seg) => (
                  <path
                    key={seg.key}
                    d={columnPath(x, y(seg.top), barWidth, y(seg.base) - y(seg.top), seg)}
                    className={cn(
                      SERIES.find((s) => s.key === seg.key)!.fill,
                      "transition-opacity duration-short2",
                      active != null && active !== i && "opacity-40",
                    )}
                  />
                ))}

                {/* Hit target spans the whole band, not just the drawn column. */}
                <rect
                  x={PAD.left + i * band}
                  y={PAD.top}
                  width={band}
                  height={PLOT.h}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${fmt(point.bucketStart)}: ${t("analytics.chartAlt", {
                    published: point.published,
                    pending: point.pending,
                    failed: point.failed,
                  })}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                  className="cursor-default"
                />
              </g>
            );
          })}

          {/* Baseline is drawn last so an empty bucket still shows a floor. */}
          <line
            x1={PAD.left}
            x2={VB.w - PAD.right}
            y1={y(0)}
            y2={y(0)}
            className="stroke-outline"
            strokeWidth={1}
          />

        </svg>

        {/*
         * The x-axis labels are HTML, not SVG <text>, because SVG has no bidi isolation:
         * an Arabic month name inside an LTR <text> comes out reordered. <bdi> fixes that,
         * and percentage padding keeps the two ends aligned to the plot at any width.
         * Only the ends are labelled — a tick under every column is unreadable.
         */}
        {series.length > 0 && (
          <div
            className="flex justify-between text-body-small text-on-surface-variant"
            style={{
              paddingInlineStart: `${(PAD.left / VB.w) * 100}%`,
              paddingInlineEnd: `${(PAD.right / VB.w) * 100}%`,
            }}
          >
            <bdi>{fmt(series[0]!.bucketStart)}</bdi>
            {series.length > 1 && <bdi>{fmt(series[series.length - 1]!.bucketStart)}</bdi>}
          </div>
        )}
      </div>

      {/*
       * Hidden from assistive tech on purpose: the focusable band announces the same
       * numbers, and a live region would repeat them on every hover.
       */}
      {activePoint && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 mx-auto w-fit rounded-sm px-3 py-2",
            "bg-inverse-surface text-inverse-on-surface shadow-2",
          )}
        >
          <div className="text-label-medium opacity-80">
            <bdi>{fmt(activePoint.bucketStart)}</bdi>
          </div>
          <dl className="mt-1 space-y-0.5">
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-label-medium">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", s.swatch)} aria-hidden="true" />
                <dt className="flex-1">{t(`analytics.status_${s.key}`)}</dt>
                <dd className="tabular-nums">{activePoint[s.key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Identity never rests on colour alone: the legend carries the names and totals. */}
      <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-label-large text-on-surface-variant">
            <span className={cn("h-2.5 w-2.5 rounded-full", s.swatch)} aria-hidden="true" />
            <span>{t(`analytics.status_${s.key}`)}</span>
            <span className="tabular-nums text-on-surface">{seriesTotals[s.key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The chart's table twin. Not a fallback — the same numbers in the form that needs no
 * colour vision, no pointer and no hover, which is what leaves the chart free to be a
 * chart.
 */
export function PostVolumeTable({ series, bucketMs }: { series: TimePoint[]; bucketMs: number }) {
  const { t, i18n } = useTranslation();
  const fmt = useMemo(() => bucketFormatter(i18n.language, bucketMs), [i18n.language, bucketMs]);
  const rows = series.filter((p) => p.published + p.pending + p.failed > 0);

  if (rows.length === 0) {
    return <p className="text-body-medium text-on-surface-variant">{t("analytics.empty")}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-medium">
        <caption className="sr-only">{t("analytics.chartTitle")}</caption>
        <thead>
          <tr className="border-b border-outline-variant text-label-medium text-on-surface-variant">
            <th scope="col" className="py-2 text-start font-normal">
              {t("analytics.bucket")}
            </th>
            {SERIES.map((s) => (
              <th key={s.key} scope="col" className="py-2 text-end font-normal">
                {t(`analytics.status_${s.key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.bucketStart} className="border-b border-outline-variant/50">
              <th scope="row" className="py-1.5 text-start font-normal text-on-surface">
                <bdi>{fmt(p.bucketStart)}</bdi>
              </th>
              {SERIES.map((s) => (
                <td key={s.key} className="py-1.5 text-end tabular-nums text-on-surface">
                  {p[s.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Segment {
  key: SeriesKey;
  base: number;
  top: number;
  /** Topmost non-zero segment — the only one with a rounded cap. */
  rounded: boolean;
  /** Something is stacked underneath, so this segment gives up 2px to the gap. */
  gapBelow: boolean;
}

/** Stack the three outcomes bottom-up, skipping the ones with no posts at all. */
function stack(point: TimePoint): Segment[] {
  const present = SERIES.filter((s) => point[s.key] > 0);
  const segments: Segment[] = [];
  let base = 0;

  present.forEach((s, i) => {
    const top = base + point[s.key];
    segments.push({ key: s.key, base, top, rounded: i === present.length - 1, gapBelow: i > 0 });
    base = top;
  });

  return segments;
}

/**
 * A column with a rounded cap and square feet. The 2px separator comes off the BOTTOM of
 * the upper segment, so the top of the stack still lands on its true value.
 */
function columnPath(x: number, y: number, w: number, h: number, seg: Segment): string {
  const height = Math.max(1, seg.gapBelow ? h - GAP : h);
  const r = seg.rounded ? Math.min(RADIUS, w / 2, height) : 0;
  const bottom = y + height;

  if (r === 0) return `M${x} ${y}h${w}v${height}h${-w}Z`;
  return [
    `M${x} ${bottom}`,
    `V${y + r}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}`,
    `h${w - 2 * r}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `V${bottom}`,
    "Z",
  ].join("");
}

/**
 * Localized month names with Latin digits: Arabic-Indic numerals on the axis would
 * disagree with the Latin figures every other number in the app is rendered with.
 */
function bucketFormatter(language: string, bucketMs: number): (ts: number) => string {
  const HOUR = 3_600_000;
  const options: Intl.DateTimeFormatOptions =
    bucketMs < HOUR
      ? { hour: "2-digit", minute: "2-digit" }
      : bucketMs <= 6 * HOUR
        ? { day: "numeric", month: "short", hour: "2-digit" }
        : { day: "numeric", month: "short" };

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(`${language}-u-nu-latn`, options);
  } catch {
    format = new Intl.DateTimeFormat(undefined, options);
  }
  return (ts) => format.format(new Date(ts));
}

function sum(series: TimePoint[], key: SeriesKey): number {
  return series.reduce((acc, p) => acc + p[key], 0);
}

/**
 * Round the axis top to something a reader can divide in their head — and keep it even,
 * so the midline lands on a whole post rather than "7.5 posts".
 */
function niceCeil(value: number): number {
  const rounded =
    value <= 5
      ? Math.max(1, Math.ceil(value))
      : (() => {
          const step = 10 ** Math.floor(Math.log10(value)) / 2;
          return Math.ceil(value / step) * step;
        })();
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
