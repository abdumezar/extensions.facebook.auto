import { useEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { formatNumber } from "../lib/format.js";
import { IconButton } from "./IconButton.js";
import { Select } from "./Select.js";
import type { IconName } from "./Icon.js";

export interface PaginationProps {
  /** 1-based, already clamped into 1..pageCount by the caller. */
  page: number;
  pageCount: number;
  /** Rows across every page, for the "A–B of N" range. */
  total: number;
  pageSize: number;
  /** Text direction of the page. Passed in, so the arrows flip with the language switch. */
  dir: "ltr" | "rtl";
  onPageChange: (page: number) => void;
  /** Both together add a rows-per-page selector. */
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
}

/** First/previous/next/last controls with the visible range, for a long list. */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  dir,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
}: PaginationProps) {
  const { t, i18n } = useTranslation();
  const num = (n: number) => formatNumber(n, i18n.language);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // A button that disables itself on click would drop keyboard focus to <body>. Remember
  // which side the user was paging toward and hand focus to the opposite, still-enabled one.
  const refocus = useRef<"previous" | "next" | null>(null);
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === "previous") previousRef.current?.focus({ preventScroll: true });
    else if (target === "next") nextRef.current?.focus({ preventScroll: true });
  }, [page]);

  function go(target: number) {
    if (target >= pageCount && page < pageCount) refocus.current = "previous";
    else if (target <= 1 && page > 1) refocus.current = "next";
    onPageChange(target);
  }
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  // Chosen by direction rather than mirrored in CSS, so the glyph itself is correct.
  const rtl = dir === "rtl";
  const icons: Record<"first" | "previous" | "next" | "last", IconName> = {
    first: rtl ? "last_page" : "first_page",
    previous: rtl ? "chevron_right" : "chevron_left",
    next: rtl ? "chevron_left" : "chevron_right",
    last: rtl ? "first_page" : "last_page",
  };
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  // Only the number pieces are isolated: the words around them keep the page direction,
  // so Arabic reads "51–100 من 230" instead of the sentence being flipped as a whole.
  const isolate = { n: <bdi dir="ltr" /> };

  return (
    <nav
      aria-label={t("pagination.label")}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-body-small text-on-surface-variant"
    >
      {pageSizeOptions && onPageSizeChange && (
        <Select
          label={t("pagination.pageSize")}
          className="w-44"
          value={String(pageSize)}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      )}
      <div className="ms-auto flex flex-wrap items-center gap-x-3">
        <span aria-live="polite">
          <Trans
            t={t}
            i18nKey="pagination.range"
            values={{ from: num(from), to: num(to), total: num(total) }}
            components={isolate}
          />
        </span>
        <span aria-live="polite">
          <Trans
            t={t}
            i18nKey="pagination.pageOf"
            values={{ page: num(page), pages: num(pageCount) }}
            components={isolate}
          />
        </span>
        <span className="flex items-center">
          <IconButton
            icon={icons.first}
            label={t("pagination.first")}
            disabled={atStart}
            onClick={() => go(1)}
          />
          <IconButton
            ref={previousRef}
            icon={icons.previous}
            label={t("pagination.previous")}
            disabled={atStart}
            onClick={() => go(page - 1)}
          />
          <IconButton
            ref={nextRef}
            icon={icons.next}
            label={t("pagination.next")}
            disabled={atEnd}
            onClick={() => go(page + 1)}
          />
          <IconButton
            icon={icons.last}
            label={t("pagination.last")}
            disabled={atEnd}
            onClick={() => go(pageCount)}
          />
        </span>
      </div>
    </nav>
  );
}
