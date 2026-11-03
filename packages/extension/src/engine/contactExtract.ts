/**
 * contactExtract — pull phone numbers and emails out of free text. Pure: no I/O, no
 * clock, no Facebook.
 *
 * This exists because Facebook does not expose a reactor's or commenter's phone
 * number and never has. The numbers that *are* reachable are the ones people typed
 * themselves — and in Arabic-language group commerce they type a lot of them
 * ("للتواصل واتساب ٠٥٥١٢٣٤٥٦٧"). A tool in this category either buys
 * enrichment data or gives up here, and both ASCII-only regexes and naive digit runs
 * fail on that string: the digits are U+0660..U+0669, the direction marks are
 * invisible, and `0551234567` is meaningless without knowing it is Saudi.
 *
 * Deliberately independent of the audience extractor so Lead Radar can run it over
 * post bodies, and so it is testable without a single Facebook fixture.
 */

import type { Contact, Region } from "@nashir/shared";

interface RegionRule {
  /** Country calling code, no plus. */
  cc: string;
  /** Trunk prefix stripped before the national number, when present. */
  trunk: string;
  /** Valid national-number lengths AFTER the trunk prefix is removed. */
  nsnLengths: number[];
  /** National numbers must start with one of these to be a mobile line. */
  mobilePrefixes: string[];
}

/**
 * Mobile numbering rules. Only mobile ranges are listed: a landline in a Facebook
 * comment is nearly always a business number already captured from the Page's own
 * contact block, and admitting landline ranges pulls in far more false positives
 * (prices, order numbers) than it yields real leads.
 */
const REGIONS: Record<Region, RegionRule> = {
  SA: { cc: "966", trunk: "0", nsnLengths: [9], mobilePrefixes: ["5"] },
  AE: {
    cc: "971",
    trunk: "0",
    nsnLengths: [9],
    mobilePrefixes: ["50", "52", "54", "55", "56", "58"],
  },
  EG: { cc: "20", trunk: "0", nsnLengths: [10], mobilePrefixes: ["10", "11", "12", "15"] },
  JO: { cc: "962", trunk: "0", nsnLengths: [9], mobilePrefixes: ["77", "78", "79"] },
  KW: { cc: "965", trunk: "", nsnLengths: [8], mobilePrefixes: ["5", "6", "9"] },
  QA: { cc: "974", trunk: "", nsnLengths: [8], mobilePrefixes: ["3", "5", "6", "7"] },
  BH: { cc: "973", trunk: "", nsnLengths: [8], mobilePrefixes: ["3"] },
  OM: { cc: "968", trunk: "", nsnLengths: [8], mobilePrefixes: ["7", "9"] },
  MA: { cc: "212", trunk: "0", nsnLengths: [9], mobilePrefixes: ["6", "7"] },
  DZ: { cc: "213", trunk: "0", nsnLengths: [9], mobilePrefixes: ["5", "6", "7"] },
  TN: { cc: "216", trunk: "", nsnLengths: [8], mobilePrefixes: ["2", "4", "5", "9"] },
  IQ: { cc: "964", trunk: "0", nsnLengths: [10], mobilePrefixes: ["75", "77", "78", "79"] },
  LB: { cc: "961", trunk: "0", nsnLengths: [7, 8], mobilePrefixes: ["3", "7", "8"] },
  SY: { cc: "963", trunk: "0", nsnLengths: [9], mobilePrefixes: ["9"] },
  PS: { cc: "970", trunk: "0", nsnLengths: [9], mobilePrefixes: ["56", "59"] },
  TR: { cc: "90", trunk: "0", nsnLengths: [10], mobilePrefixes: ["5"] },
  YE: { cc: "967", trunk: "0", nsnLengths: [9], mobilePrefixes: ["7"] },
  LY: { cc: "218", trunk: "0", nsnLengths: [9], mobilePrefixes: ["9"] },
  SD: { cc: "249", trunk: "0", nsnLengths: [9], mobilePrefixes: ["9", "1"] },
};

/** Every country code we know, longest first — so 966 wins over 96 on a prefix test. */
const CC_BY_LENGTH: Array<{ cc: string; region: Region }> = (
  Object.entries(REGIONS) as Array<[Region, RegionRule]>
)
  .map(([region, r]) => ({ cc: r.cc, region }))
  .sort((a, b) => b.cc.length - a.cc.length);

export type { Contact, Region } from "@nashir/shared";

export interface ExtractOptions {
  /**
   * Region assumed for a number written without a country code. There is no safe
   * default here — `0551234567` is a valid mobile in several of these plans and means
   * a different person in each — so an un-prefixed number with no region hint is
   * dropped rather than guessed at.
   */
  defaultRegion?: Region;
  /** Minimum confidence to return. Defaults to 0 (return all, let the UI filter). */
  minConfidence?: number;
}

// ---------------------------------------------------------------- normalisation

/** Arabic-Indic (U+0660..0669) and Extended/Persian (U+06F0..06F9) digits. */
const ARABIC_INDIC_START = 0x0660;
const EXTENDED_INDIC_START = 0x06f0;

/**
 * Fold non-ASCII digits to ASCII and strip the invisible characters that break every
 * naive regex: LRM/RLM/ALM, the directional isolates, ZWJ/ZWNJ, and tatweel — all of
 * which Facebook's own composer inserts into RTL text without the author seeing them.
 */
export function foldDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= ARABIC_INDIC_START && cp <= ARABIC_INDIC_START + 9) {
      out += String(cp - ARABIC_INDIC_START);
    } else if (cp >= EXTENDED_INDIC_START && cp <= EXTENDED_INDIC_START + 9) {
      out += String(cp - EXTENDED_INDIC_START);
    } else if (
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x061c ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0x0640
    ) {
      // Dropped, not replaced with a space: these carry no width, so substituting one
      // would split a number the author wrote as a single run.
    } else {
      out += ch;
    }
  }
  return out;
}

/** Arabic comma/semicolon and the dash family, folded so separators match. */
function normalisePunctuation(input: string): string {
  return input
    .replace(/[،؛]/g, ",")
    .replace(/[－‐-―−]/g, "-")
    .replace(/[٫٬]/g, "");
}

export function normaliseText(input: string): string {
  return normalisePunctuation(foldDigits(input.normalize("NFKC")));
}

// ---------------------------------------------------------------- rejection

/** Currency markers, in either language. A number next to one is a price. */
const CURRENCY =
  /(ر\.?س|ريال|درهم|جنيه|دينار|دولار|\bSAR\b|\bAED\b|\bEGP\b|\bKWD\b|\bUSD\b|\$|€|£)/i;

/**
 * Digit runs that are never a phone number. Each entry here is a false positive that
 * would otherwise be exported as a lead.
 */
function isObviouslyNotPhone(digits: string, context: string): boolean {
  // A year, a price, a quantity.
  if (digits.length < 7) return true;
  // Facebook ids and epoch-ms timestamps: 16-17 digits, past any national plan.
  if (digits.length > 15) return true;
  // All-same or strictly sequential — placeholder text, not a number.
  if (/^(\d)\1+$/.test(digits)) return true;
  if ("01234567890".includes(digits) || "09876543210".includes(digits)) return true;
  if (CURRENCY.test(context)) return true;
  return false;
}

/** Words near a number that make it far more likely to be a contact number. */
const CONTACT_HINT =
  /(واتس|واتساب|تواصل|اتصال|اتصل|جوال|موبايل|هاتف|رقم|للاستفسار|whats\s?app|whatsapp|call|phone|mobile|tel|contact|dm)/i;

// ---------------------------------------------------------------- phones

interface Candidate {
  digits: string;
  hadPlus: boolean;
  raw: string;
  context: string;
}

/**
 * Digit runs, tolerating the separators people actually type: spaces, dashes, dots,
 * slashes, parenthesised area codes. A leading `+` or `00` is captured because it is
 * the strongest signal in the string — it means the author supplied a country code.
 */
const PHONE_CANDIDATE = /(?:\+|00)?\d[\d\s\-.()/]{5,20}\d/g;

function candidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const raw = m[0];
    const idx = m.index ?? 0;
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 0) continue;
    const before = text.slice(Math.max(0, idx - 1), idx);
    out.push({
      digits,
      hadPlus: before === "+" || raw.startsWith("+") || /^00/.test(raw),
      raw: raw.trim(),
      context: text.slice(Math.max(0, idx - 40), idx + raw.length + 20),
    });
  }
  return out;
}

interface Resolved {
  e164: string;
  region?: Region;
  confidence: number;
}

/**
 * Turn a digit run into E.164, or null when it cannot be a mobile number in any plan
 * we know. Returning null is the common case and the correct one — most digit runs in
 * a comment thread are prices.
 */
function resolvePhone(c: Candidate, defaultRegion?: Region): Resolved | null {
  let digits = c.digits;
  if (digits.startsWith("00")) digits = digits.slice(2);

  // 1. An explicit country code we recognise. Highest confidence: the author said so.
  for (const { cc, region } of CC_BY_LENGTH) {
    if (!digits.startsWith(cc)) continue;
    const rule = REGIONS[region];
    let nsn = digits.slice(cc.length);
    // Some people write +966 0551234567 — country code AND trunk prefix.
    if (rule.trunk && nsn.startsWith(rule.trunk)) nsn = nsn.slice(rule.trunk.length);
    if (!rule.nsnLengths.includes(nsn.length)) continue;
    if (!rule.mobilePrefixes.some((p) => nsn.startsWith(p))) continue;
    return { e164: `+${cc}${nsn}`, region, confidence: c.hadPlus ? 0.95 : 0.85 };
  }

  // 2. A national number, resolved against the operator's stated region.
  if (defaultRegion) {
    const rule = REGIONS[defaultRegion];
    let nsn = digits;
    if (rule.trunk && nsn.startsWith(rule.trunk)) nsn = nsn.slice(rule.trunk.length);
    if (rule.nsnLengths.includes(nsn.length) && rule.mobilePrefixes.some((p) => nsn.startsWith(p))) {
      // Lower than an explicit code: correct for this region, a guess for any other.
      return { e164: `+${rule.cc}${nsn}`, region: defaultRegion, confidence: 0.75 };
    }
  }

  // 3. A plausible international number we have no plan for. Kept, but flagged low —
  //    exporting it is the operator's call, and dropping it silently would lose real
  //    leads from every region this table does not cover.
  if (c.hadPlus && digits.length >= 8 && digits.length <= 15) {
    return { e164: `+${digits}`, confidence: 0.5 };
  }
  return null;
}

// ---------------------------------------------------------------- whatsapp links

const WA_LINK = /(?:wa\.me|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send)\S*/gi;

/**
 * A WhatsApp click-to-chat link always carries a full international number with no
 * plus, which makes it the most reliable source in this module — there is nothing to
 * infer, and the author published it precisely so people would call it.
 */
export function extractWhatsappLinks(text: string): Contact[] {
  const out: Contact[] = [];
  for (const m of text.matchAll(WA_LINK)) {
    const url = m[0];
    let digits = "";
    const q = /[?&]phone=(\+?[\d\s-]+)/i.exec(url);
    if (q?.[1]) {
      digits = q[1].replace(/\D/g, "");
    } else {
      const path = /wa\.me\/(\+?\d+)/i.exec(url);
      if (path?.[1]) digits = path[1].replace(/\D/g, "");
    }
    if (digits.length < 8 || digits.length > 15) continue;
    const region = CC_BY_LENGTH.find((x) => digits.startsWith(x.cc))?.region;
    out.push({
      kind: "phone",
      value: `+${digits}`,
      confidence: 0.98,
      raw: url,
      whatsapp: true,
      ...(region ? { region } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- emails

/**
 * Unicode-aware local part, because internationalised addresses exist and rejecting
 * them silently loses leads. The TLD is held to letters so a filename ("photo.jpg")
 * sitting next to an @ does not become an address.
 */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

export function extractEmails(text: string): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const m of text.matchAll(EMAIL)) {
    const value = m[0].toLowerCase().replace(/[.,;:]+$/, "");
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ kind: "email", value, confidence: 0.9, raw: m[0] });
  }
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * Everything contactable in a piece of text, best first.
 *
 * Deduped by value, keeping the highest-confidence sighting: the same number written
 * once as a wa.me link and once as bare digits is one lead, and the link is the
 * version we trust.
 */
export function extractContacts(input: string, opts: ExtractOptions = {}): Contact[] {
  if (!input) return [];
  const text = normaliseText(input);
  const found: Contact[] = [...extractWhatsappLinks(text), ...extractEmails(text)];

  for (const c of candidates(text)) {
    if (isObviouslyNotPhone(c.digits, c.context)) continue;
    const resolved = resolvePhone(c, opts.defaultRegion);
    if (!resolved) continue;
    // A contact word beside the digits is real evidence; a bare number in the middle
    // of a sentence is usually a measurement.
    const bonus = CONTACT_HINT.test(c.context) ? 0.1 : 0;
    found.push({
      kind: "phone",
      value: resolved.e164,
      confidence: Math.min(1, resolved.confidence + bonus),
      raw: c.raw,
      ...(resolved.region ? { region: resolved.region } : {}),
    });
  }

  const best = new Map<string, Contact>();
  for (const c of found) {
    const prev = best.get(c.value);
    if (!prev || c.confidence > prev.confidence) best.set(c.value, c);
  }
  const min = opts.minConfidence ?? 0;
  return [...best.values()]
    .filter((c) => c.confidence >= min)
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}
