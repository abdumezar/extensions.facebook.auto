/** Humanize a duration in ms as a compact "1h 20m" / "12m" / "45s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 && m < 5 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/**
 * A request round-trip, where the interesting differences live below a second —
 * formatDuration would round 1,420ms and 1,900ms to the same "1s".
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

/**
 * Date + time for a log row. Latin digits regardless of locale, so figures read the
 * same everywhere in the app while month names still follow the chosen language.
 */
export function formatTimestamp(ts: number, language: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat(`${language}-u-nu-latn`, options).format(ts);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(ts);
  }
}
