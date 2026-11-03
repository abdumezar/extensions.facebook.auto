import { describe, expect, it } from "vitest";
import { type LeadRule, scoreAgainstRules, scorePost } from "./leadScore.js";

const rule = (over: Partial<LeadRule> = {}): LeadRule => ({
  id: "r1",
  groupIds: [],
  keywords: ["شقة", "apartment"],
  enabled: true,
  ...over,
});

const score = (text: string, over: Partial<LeadRule> = {}) => scorePost(text, rule(over)).score;

describe("the distinction the whole feature rests on: demand vs supply", () => {
  it("scores a buyer high", () => {
    expect(score("ابحث عن شقة للسكن في الرياض، ميزانيتي بحدود ٣٠٠٠")).toBeGreaterThanOrEqual(70);
  });

  it("scores a seller using the same noun near zero", () => {
    // Identical topic, opposite direction. Without this the radar surfaces the
    // other sellers advertising, which is worse than silence.
    expect(score("شقة للايجار في الرياض، تواصل معنا للحجز")).toBeLessThan(30);
  });

  it("does the same in English", () => {
    expect(score("Looking for an apartment near downtown, any recommendations?")).toBeGreaterThanOrEqual(
      70,
    );
    expect(score("Apartment for rent downtown — contact us to book now")).toBeLessThan(30);
  });
});

describe("scorePost", () => {
  it("scores zero when no keyword matched", () => {
    const out = scorePost("سيارة مستعملة للبيع", rule());
    expect(out.score).toBe(0);
    expect(out.matched).toEqual([]);
  });

  it("drops the post when an exclusion fires, whatever else hit", () => {
    const out = scorePost("ابحث عن شقة للمشاركة", rule({ excludeKeywords: ["للمشاركة"] }));
    expect(out.excluded).toBe(true);
    expect(out.score).toBe(0);
  });

  it("matches through Arabic diacritics and alef variants", () => {
    // People type أ / ا / إ interchangeably; equality on the raw text misses most posts.
    expect(score("أبحث عن شَقّة", { keywords: ["ابحث", "شقه"] })).toBeGreaterThan(0);
  });

  it("matches through Arabic-Indic digits and direction marks", () => {
    expect(score("محتاج شقة ب ٣٠٠٠ ريال")).toBeGreaterThan(0);
  });

  it("is case-insensitive in English", () => {
    expect(score("LOOKING FOR AN APARTMENT")).toBeGreaterThan(0);
  });

  it("rewards a question, urgency and a stated budget", () => {
    const plain = score("محتاج شقة في الرياض للسكن قريبا");
    const loaded = score("محتاج شقة ضروري اليوم، كم سعر الايجار؟");
    expect(loaded).toBeGreaterThan(plain);
  });

  it("penalises a post too short to be a brief", () => {
    expect(score("شقة")).toBeLessThan(score("محتاج شقة في الرياض للسكن"));
  });

  it("counts a keyword once however often it is repeated", () => {
    // Corroboration means a second *distinct* keyword, not a louder one. Both posts
    // are the same length, so the short-post penalty does not confound the comparison.
    const once = score("محتاج شقة في الرياض للسكن قريبا جدا", { keywords: ["شقة"] });
    const stuffed = score("محتاج شقة شقة شقة شقة شقة شقة", { keywords: ["شقة"] });
    expect(stuffed).toBe(once);
  });

  it("caps corroboration at two extra keywords", () => {
    const opts = { keywords: ["شقة", "apartment", "سكن", "flat", "منزل"] };
    const two = score("محتاج شقة apartment في الرياض", opts);
    const five = score("محتاج شقة apartment سكن flat منزل في الرياض", opts);
    // Two more distinct hits are worth 5 points; the next two are worth nothing.
    expect(five - two).toBe(5);
  });

  it("never leaves the 0..100 range", () => {
    const out = scorePost(
      "ابحث عن محتاج مطلوب شقة ضروري عاجل اليوم كم سعر؟ ميزانيتي",
      rule({ keywords: ["شقة"] }),
    );
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
    expect(scorePost("شقة للبيع عندنا خصم عرض خاص", rule()).score).toBeGreaterThanOrEqual(0);
  });

  it("explains itself, so a wrong score is diagnosable rather than mysterious", () => {
    const out = scorePost("ابحث عن شقة ضروري؟", rule());
    expect(out.reasons.some((r) => r.startsWith("demand:"))).toBe(true);
    expect(out.reasons).toContain("question");
    expect(out.reasons.some((r) => r.startsWith("urgent:"))).toBe(true);
  });
});

describe("scoreAgainstRules", () => {
  const buyer = "ابحث عن شقة في الرياض، محتاجها ضروري";

  it("returns nothing when every rule is disabled", () => {
    expect(scoreAgainstRules(buyer, "g1", [rule({ enabled: false })])).toBeNull();
  });

  it("respects a rule scoped to other groups", () => {
    expect(scoreAgainstRules(buyer, "g1", [rule({ groupIds: ["g2"] })])).toBeNull();
    expect(scoreAgainstRules(buyer, "g2", [rule({ groupIds: ["g2"] })])).not.toBeNull();
  });

  it("honours a rule's own threshold", () => {
    expect(scoreAgainstRules(buyer, "g1", [rule({ minScore: 99 })])).toBeNull();
    expect(scoreAgainstRules(buyer, "g1", [rule({ minScore: 10 })])).not.toBeNull();
  });

  it("reports one winner, not one hit per rule", () => {
    // A post matching two rules is one notification. The operator cares that
    // something worth answering appeared, not how many filters agreed.
    const out = scoreAgainstRules(buyer, "g1", [
      rule({ id: "a", keywords: ["شقة"] }),
      rule({ id: "b", keywords: ["ابحث"] }),
    ]);
    expect(out).not.toBeNull();
    expect(typeof out?.rule.id).toBe("string");
  });

  it("picks the highest-scoring rule", () => {
    const out = scoreAgainstRules(buyer, "g1", [
      rule({ id: "weak", keywords: ["شقة"], minScore: 0 }),
      rule({ id: "strong", keywords: ["شقة", "ابحث"], minScore: 0 }),
    ]);
    expect(out?.rule.id).toBe("strong");
  });

  it("drops a seller even when the keyword rule would otherwise pass", () => {
    expect(scoreAgainstRules("شقة للايجار تواصل معنا", "g1", [rule({ minScore: 50 })])).toBeNull();
  });
});
