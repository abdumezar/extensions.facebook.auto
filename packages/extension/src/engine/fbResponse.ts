/**
 * fbResponse — the one place that knows how Facebook shapes a response.
 *
 * Every internal endpoint prefixes its JSON with `for (;;);` (an anti-JSON-hijacking
 * guard) and may stream several JSON objects separated by newlines. Six services used
 * to carry their own copy of that dance; they all call in here now, so a change in
 * Facebook's framing is a one-file change.
 *
 * It also reads the parts of an error Facebook sends that the app used to throw away:
 * the numeric codes. `errors[].code` is what separates "you posted a malformed thing"
 * from "stop calling us", and until now nothing looked at it.
 *
 * Pure: no ports, no clock, no recipe. Classification lives in `governorMath`.
 */

/** Strip the `for (;;);` guard and surrounding whitespace. Safe on text that lacks it. */
export function stripFbPrefix(text: string): string {
  return text.replace(/^for\s*\(;;\);/, "").trim();
}

/**
 * Parse one Facebook response body. Returns null rather than throwing — every caller
 * treats an unparseable body as a failure, and none of them wants a try/catch.
 *
 * Facebook sometimes returns several JSON objects newline-separated (streamed relay
 * responses); the first line is the one that carries the result.
 */
export function parseFbJson(text: string): unknown | null {
  const cleaned = stripFbPrefix(text);
  try {
    return JSON.parse(cleaned.split("\n")[0] ?? cleaned);
  } catch {
    return null;
  }
}

/** One error, normalised across the several shapes Facebook uses for them. */
export interface FbError {
  message?: string;
  summary?: string;
  description?: string;
  /** The numeric code. This is the field the whole rate-limit taxonomy hangs off. */
  code?: number;
  subcode?: number;
  /** Facebook's own verdict that a retry is reasonable. Advisory, and often absent. */
  isTransient?: boolean;
  allowUserRetry?: boolean;
  severity?: string;
}

function numeric(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // FB is inconsistent about quoting codes; "1357004" and 1357004 both occur.
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function normalise(raw: Record<string, unknown>): FbError {
  const code =
    numeric(raw.code) ??
    numeric(raw.api_error_code) ??
    numeric(raw.error_code) ??
    numeric(raw.errorCode);
  return {
    message: typeof raw.message === "string" ? raw.message : undefined,
    summary:
      typeof raw.summary === "string"
        ? raw.summary
        : typeof raw.errorSummary === "string"
          ? raw.errorSummary
          : undefined,
    description:
      typeof raw.description === "string"
        ? raw.description
        : typeof raw.errorDescription === "string"
          ? raw.errorDescription
          : undefined,
    code,
    subcode: numeric(raw.error_subcode) ?? numeric(raw.subcode),
    isTransient: typeof raw.is_transient === "boolean" ? raw.is_transient : undefined,
    allowUserRetry: typeof raw.allow_user_retry === "boolean" ? raw.allow_user_retry : undefined,
    severity: typeof raw.severity === "string" ? raw.severity : undefined,
  };
}

/**
 * Every error in a parsed body, from any of the three shapes Facebook uses:
 *  - GraphQL:      `{ errors: [{ message, code, severity, ... }] }`
 *  - Graph API:    `{ error: { message, code, error_subcode, type } }`
 *  - internal www: `{ error: 1357004, errorSummary, errorDescription }`
 */
export function fbErrorsOf(json: unknown): FbError[] {
  if (json == null || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const out: FbError[] = [];

  if (Array.isArray(root.errors)) {
    for (const e of root.errors) {
      if (e && typeof e === "object") out.push(normalise(e as Record<string, unknown>));
    }
  }

  const err = root.error;
  if (err && typeof err === "object" && !Array.isArray(err)) {
    out.push(normalise(err as Record<string, unknown>));
  } else if (err != null && err !== false && err !== 0) {
    // The internal-www shape: `error` is the code itself, and the human-readable
    // halves sit beside it at the top level.
    out.push(
      normalise({
        code: err,
        errorSummary: root.errorSummary,
        errorDescription: root.errorDescription,
      }),
    );
  }

  return out;
}

/** A single human-readable line from a set of errors, for logs and the operator. */
export function fbErrorText(errors: FbError[]): string | undefined {
  const parts = errors
    .map((e) => e.message ?? e.summary ?? e.description ?? (e.code != null ? `#${e.code}` : ""))
    .filter((s) => s.length > 0);
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Everything an error carries, as one lowercased haystack for signal matching.
 * Includes the description, which the old parser dropped — and which is exactly
 * where "There have been too many calls from this app" lives.
 */
export function fbErrorHaystack(errors: FbError[]): string {
  return errors
    .flatMap((e) => [e.message, e.summary, e.description, e.severity])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
}
