import type { Region } from "@nashir/shared";
import { describe, expect, it } from "vitest";
import {
  extractContacts,
  extractEmails,
  extractWhatsappLinks,
  foldDigits,
} from "./contactExtract.js";

/** Phones only, in order, for the common assertion. */
const phones = (s: string, region?: Region): string[] =>
  extractContacts(s, region ? { defaultRegion: region } : {})
    .filter((c) => c.kind === "phone")
    .map((c) => c.value);

describe("foldDigits", () => {
  it("folds Arabic-Indic digits to ASCII", () => {
    expect(foldDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("folds Extended/Persian digits to ASCII", () => {
    expect(foldDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("strips zero-width direction marks without splitting the number", () => {
    // RLM in the middle of a run: dropping it must join, not separate.
    expect(foldDigits("055‏1234567")).toBe("0551234567");
    expect(foldDigits("‎055؜1234567⁦")).toBe("0551234567");
  });

  it("strips tatweel", () => {
    expect(foldDigits("ــ055")).toBe("055");
  });

  it("leaves ordinary text alone", () => {
    expect(foldDigits("hello مرحبا")).toBe("hello مرحبا");
  });
});

describe("phone extraction — the Arabic case this module exists for", () => {
  it("reads a Saudi mobile written in Arabic-Indic digits", () => {
    expect(phones("للتواصل واتساب ٠٥٥١٢٣٤٥٦٧", "SA")).toEqual(["+966551234567"]);
  });

  it("reads it through invisible direction marks", () => {
    expect(phones("جوال‏ ٠٥٠‏١٢٣‏٤٥٦٧", "SA")).toEqual(["+966501234567"]);
  });

  it("reads a number the author separated with dashes and spaces", () => {
    expect(phones("رقمي 055-123 45 67", "SA")).toEqual(["+966551234567"]);
  });

  it("prefers the explicit country code over the default region", () => {
    // Written as a UAE number while the operator's default is Saudi.
    expect(phones("+971 50 123 4567", "SA")).toEqual(["+971501234567"]);
  });

  it("accepts 00 as an international prefix", () => {
    expect(phones("00966551234567")).toEqual(["+966551234567"]);
  });

  it("handles a country code followed by a redundant trunk zero", () => {
    expect(phones("+966 0551234567")).toEqual(["+966551234567"]);
  });
});

describe("phone extraction — per-region plans", () => {
  const cases: Array<[Region, string, string]> = [
    ["SA", "0551234567", "+966551234567"],
    ["AE", "0501234567", "+971501234567"],
    ["EG", "01012345678", "+201012345678"],
    ["JO", "0791234567", "+962791234567"],
    ["KW", "51234567", "+96551234567"],
    ["IQ", "07712345678", "+9647712345678"],
    ["TR", "05321234567", "+905321234567"],
  ];

  for (const [region, national, expected] of cases) {
    it(`${region}: ${national} -> ${expected}`, () => {
      expect(phones(national, region as Region)).toEqual([expected]);
    });
  }

  it("rejects a national number when no region is given", () => {
    // 0551234567 is a valid mobile in more than one of these plans, so guessing
    // would attribute a lead to the wrong country.
    expect(phones("0551234567")).toEqual([]);
  });

  it("rejects a landline range even in a known region", () => {
    // Saudi mobiles start with 5; 011 is a Riyadh landline.
    expect(phones("0112345678", "SA")).toEqual([]);
  });
});

describe("rejection — the false positives that would otherwise ship as leads", () => {
  it("rejects a price", () => {
    expect(phones("السعر 1500 ريال فقط", "SA")).toEqual([]);
    expect(phones("only 2500 SAR", "SA")).toEqual([]);
  });

  it("rejects a price even when the digits form a valid mobile", () => {
    expect(phones("بسعر 0551234567 ريال", "SA")).toEqual([]);
  });

  it("rejects short runs like years and quantities", () => {
    expect(phones("موديل 2024 عدد 50", "SA")).toEqual([]);
  });

  it("rejects a Facebook id", () => {
    expect(phones("100078234512345678", "SA")).toEqual([]);
  });

  it("rejects repeated and sequential placeholder digits", () => {
    expect(phones("0000000000", "SA")).toEqual([]);
    expect(phones("0123456789", "SA")).toEqual([]);
  });
});

describe("confidence", () => {
  it("scores an explicit country code above an inferred one", () => {
    const explicit = extractContacts("+966551234567")[0];
    const inferred = extractContacts("0551234567", { defaultRegion: "SA" })[0];
    expect(explicit?.confidence).toBeGreaterThan(inferred?.confidence ?? 1);
  });

  it("raises confidence when a contact word sits beside the number", () => {
    const bare = extractContacts("551234567 966", { defaultRegion: "SA" });
    const hinted = extractContacts("واتساب ٠٥٥١٢٣٤٥٦٧", { defaultRegion: "SA" })[0];
    expect(hinted?.confidence).toBeGreaterThan(0.75);
    expect(bare).toBeDefined();
  });

  it("honours minConfidence", () => {
    const all = extractContacts("+4712345678");
    expect(all.length).toBe(1);
    expect(extractContacts("+4712345678", { minConfidence: 0.7 })).toEqual([]);
  });

  it("keeps an unknown-plan international number at low confidence rather than dropping it", () => {
    const [c] = extractContacts("+4915112345678");
    expect(c?.value).toBe("+4915112345678");
    expect(c?.confidence).toBeLessThan(0.7);
    expect(c?.region).toBeUndefined();
  });
});

describe("whatsapp links", () => {
  it("reads a wa.me path number", () => {
    expect(extractWhatsappLinks("https://wa.me/966551234567")[0]).toMatchObject({
      value: "+966551234567",
      whatsapp: true,
      region: "SA",
    });
  });

  it("reads an api.whatsapp.com phone parameter", () => {
    expect(
      extractWhatsappLinks("https://api.whatsapp.com/send?phone=971501234567&text=hi")[0],
    ).toMatchObject({ value: "+971501234567", whatsapp: true });
  });

  it("scores a link above bare digits, and dedupes to the link", () => {
    const out = extractContacts("wa.me/966551234567 أو اتصل ٠٥٥١٢٣٤٥٦٧", {
      defaultRegion: "SA",
    });
    const hits = out.filter((c) => c.value === "+966551234567");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.whatsapp).toBe(true);
  });

  it("ignores a link with an implausible number", () => {
    expect(extractWhatsappLinks("wa.me/123")).toEqual([]);
  });
});

describe("emails", () => {
  it("finds and lower-cases an address", () => {
    expect(extractEmails("Contact: Sales@Example.COM")[0]?.value).toBe("sales@example.com");
  });

  it("strips trailing sentence punctuation", () => {
    expect(extractEmails("write to a@b.com.")[0]?.value).toBe("a@b.com");
  });

  it("does not treat a filename beside an @ as an address", () => {
    expect(extractEmails("@ photo.jpg")).toEqual([]);
  });

  it("dedupes repeats", () => {
    expect(extractEmails("a@b.com and a@b.com")).toHaveLength(1);
  });
});

describe("extractContacts", () => {
  it("returns nothing for empty input", () => {
    expect(extractContacts("")).toEqual([]);
  });

  it("pulls several distinct contacts out of one comment, best first", () => {
    const out = extractContacts(
      "للتواصل ٠٥٥١٢٣٤٥٦٧ أو ٠٥٠٧٦٥٤٣٢١ والإيميل shop@example.com",
      { defaultRegion: "SA" },
    );
    expect(out.map((c) => c.value)).toEqual(
      expect.arrayContaining(["+966551234567", "+966507654321", "shop@example.com"]),
    );
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.confidence).toBeGreaterThanOrEqual(out[i]!.confidence);
    }
  });

  it("keeps the raw substring so the operator can see the source", () => {
    const [c] = extractContacts("رقمي ٠٥٥١٢٣٤٥٦٧", { defaultRegion: "SA" });
    expect(c?.raw).toContain("0551234567");
  });
});
