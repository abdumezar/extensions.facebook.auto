/**
 * Hand a generated file to the browser.
 *
 * Lifted out of AnalyticsPage when the audience export became a third caller (the
 * feasibility report was the second, with its own copy). Two details here are
 * load-bearing and both were learned the hard way:
 *
 *  - The **BOM**. Without it Excel reads a UTF-8 CSV as the system codepage and every
 *    Arabic name arrives as mojibake — which is most of what these exports contain.
 *    The same applies to a Markdown report opened in a Windows editor.
 *  - **Deferred revoke**. Revoking the object URL synchronously races the download in
 *    Chromium and yields an empty file.
 */

export type DownloadFormat = "csv" | "json" | "md";

const MIME: Record<DownloadFormat, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json",
  md: "text/markdown;charset=utf-8",
};

/** JSON is machine-read and a BOM would break a strict parser; the text formats need it. */
const NEEDS_BOM: Record<DownloadFormat, boolean> = { csv: true, json: false, md: true };

export function saveFile(content: string, filename: string, format: DownloadFormat): void {
  const body = NEEDS_BOM[format] ? `﻿${content}` : content;
  const url = URL.createObjectURL(new Blob([body], { type: MIME[format] }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
