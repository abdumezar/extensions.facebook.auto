/**
 * leadScore — decide whether a group post is somebody trying to buy. Pure.
 *
 * The naive version of this feature is a keyword alarm, and a keyword alarm on a
 * Facebook group is useless within a day: "شقة للإيجار" matches every landlord
 * advertising as well as every tenant looking, and the operator gets fifty
 * notifications for the one they wanted. The distinction that matters is not *topic*
 * but *direction* — is this person asking or offering.
 *
 * So the score has two halves: did the post match what you watch for, and does it
 * read as demand rather than supply. Deterministic and cheap.
 */

import { normaliseText } from "./contactExtract.js";

export interface LeadRule {
  id: string;
  /** Group ids this rule watches. Empty = every watched group. */
  groupIds: string[];
  /** Any of these present = a match. Matched case- and diacritic-insensitively. */
  keywords: string[];
  /** Any of these present = never a match, whatever else hit. */
  excludeKeywords?: string[];
  /** Below this, no notification. 0..100. */
  minScore?: number;
  enabled: boolean;
  label?: string;
}

export interface ScoredPost {
  /** 0..100. */
  score: number;
  /** Which keywords hit, for showing the operator why they were interrupted. */
  matched: string[];
  /** Signals that pushed the score up or down, for the same reason. */
  reasons: string[];
  /** True when an exclusion fired — the post is dropped whatever the score. */
  excluded: boolean;
}

/**
 * Phrases that mean the author WANTS something. Weighted highest because this is the
 * whole point: a buyer and a seller use identical nouns.
 */
const DEMAND = [
  // Arabic
  "ابحث عن", "أبحث عن", "ادور على", "أدور على", "محتاج", "احتاج", "أحتاج", "مطلوب",
  "ابي", "أبي", "ابغى", "أبغى", "عايز", "عاوز", "نفسي في", "حد يعرف", "مين يعرف",
  "في حد", "فيه احد", "ينصحني", "اقتراحات", "وش تنصحوني", "دلوني", "ابحث",
  // English
  "looking for", "need a", "need an", "i need", "anyone know", "any recommendations",
  "recommend a", "recommend an", "can anyone", "where can i", "who can", "wanted",
  "searching for", "in the market for", "help me find",
];

/** Phrases that mean the author is SELLING. A strong negative — this is a seller, not a buyer. */
const SUPPLY = [
  "للبيع", "للايجار", "للإيجار", "معروض", "عندنا", "لدينا", "نوفر", "نقدم",
  "تواصل معنا", "اتصل بنا", "خصم", "عرض خاص", "افضل الاسعار", "أفضل الأسعار",
  "خدماتنا", "منتجاتنا", "وكيل", "شركتنا",
  "for sale", "for rent", "we offer", "we provide", "our services", "contact us",
  "dm us", "special offer", "discount", "best price", "book now", "order now",
];

/** Urgency. A real buyer in a hurry is the best lead there is. */
const URGENCY = [
  "ضروري", "عاجل", "بسرعة", "اليوم", "بكرة", "حالا", "حالاً", "الان", "الآن",
  "urgent", "asap", "today", "immediately", "right now", "this week",
];

/** Someone naming a budget is past browsing. */
const BUDGET = [
  "ميزانيتي", "ميزانية", "بحدود", "في حدود", "لا يزيد عن", "كم سعر", "بكم", "السعر",
  "budget", "how much", "price range", "up to", "around",
];

/** A question mark, in either script. */
const QUESTION = /[?؟]/;

function foldForMatch(text: string): string {
  return (
    normaliseText(text)
      .toLowerCase()
      // Arabic diacritics — people type them inconsistently and they break equality.
      .replace(/[ً-ْٰ]/g, "")
      // Alef and ya/hamza variants folded to one form each, the single biggest source
      // of missed matches in Arabic keyword search.
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/\s+/g, " ")
  );
}

function countHits(haystack: string, needles: string[]): string[] {
  const folded = needles.map((n) => foldForMatch(n));
  const out: string[] = [];
  for (let i = 0; i < folded.length; i++) {
    const n = folded[i]!;
    if (n.length > 0 && haystack.includes(n)) out.push(needles[i]!);
  }
  return out;
}

/**
 * Score one post against one rule.
 *
 * The weights are deliberately blunt. A calibrated model would need labelled data we
 * do not have, and a blunt rule the operator can read and adjust beats a smooth one
 * they cannot — the `reasons` array exists so a wrong score is diagnosable rather
 * than mysterious.
 */
export function scorePost(text: string, rule: LeadRule): ScoredPost {
  const hay = foldForMatch(text);
  const matched = countHits(hay, rule.keywords);
  const excluded = countHits(hay, rule.excludeKeywords ?? []).length > 0;

  if (matched.length === 0 || excluded) {
    return { score: 0, matched, reasons: excluded ? ["excluded"] : [], excluded };
  }

  const reasons: string[] = [];
  // A keyword hit alone is worth little — it is the price of entry, not the signal.
  let score = 25;
  reasons.push(`keyword:${matched.length}`);
  // A second distinct keyword is real corroboration; a tenth is not, so this is capped.
  score += Math.min(matched.length - 1, 2) * 5;

  const demand = countHits(hay, DEMAND);
  if (demand.length > 0) {
    score += 35;
    reasons.push(`demand:${demand[0]}`);
  }

  const supply = countHits(hay, SUPPLY);
  if (supply.length > 0) {
    // The single most valuable rule here. Without it the radar surfaces the
    // other sellers advertising, which is worse than silence.
    score -= 45;
    reasons.push(`supply:${supply[0]}`);
  }

  if (QUESTION.test(text)) {
    score += 10;
    reasons.push("question");
  }

  const urgent = countHits(hay, URGENCY);
  if (urgent.length > 0) {
    score += 15;
    reasons.push(`urgent:${urgent[0]}`);
  }

  const budget = countHits(hay, BUDGET);
  if (budget.length > 0) {
    score += 10;
    reasons.push(`budget:${budget[0]}`);
  }

  // A one-word post is not a brief, and a 2000-word one is a manifesto.
  const words = hay.split(" ").filter(Boolean).length;
  if (words < 4) {
    score -= 15;
    reasons.push("too_short");
  }

  return { score: clamp(score), matched, reasons, excluded: false };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The best score across every rule that applies to a group.
 *
 * A post matching two rules is one notification, not two — the operator cares that
 * something worth answering appeared, not how many of their filters agreed.
 */
export function scoreAgainstRules(
  text: string,
  groupId: string,
  rules: LeadRule[],
): { best: ScoredPost; rule: LeadRule } | null {
  let winner: { best: ScoredPost; rule: LeadRule } | null = null;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.groupIds.length > 0 && !rule.groupIds.includes(groupId)) continue;
    const scored = scorePost(text, rule);
    if (scored.excluded || scored.score < (rule.minScore ?? 50)) continue;
    if (!winner || scored.score > winner.best.score) winner = { best: scored, rule };
  }
  return winner;
}
