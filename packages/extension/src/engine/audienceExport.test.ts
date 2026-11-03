import type { AudienceContact } from "@nashir/shared";
import { describe, expect, it } from "vitest";
import { fillTemplate, toCsv, toJson, toPhoneCsv, whatsappLink } from "./audienceExport.js";

const person = (over: Partial<AudienceContact> = {}): AudienceContact => ({
  id: "100001",
  name: "Omar",
  profileUrl: "https://www.facebook.com/omar",
  contacts: [
    { kind: "phone", value: "+966551234567", confidence: 0.95, raw: "0551234567" },
    { kind: "email", value: "omar@example.com", confidence: 0.9, raw: "omar@example.com" },
  ],
  sightings: [
    {
      source: "post.commenter",
      postUrl: "https://fb/p/1",
      feedbackId: "1",
      commentId: "c1",
      text: "مهتم",
      capturedAt: 0,
    },
  ],
  bestConfidence: 0.95,
  firstSeenAt: 0,
  lastSeenAt: 86_400_000,
  ...over,
});

describe("toCsv", () => {
  it("writes a header and one row per person", () => {
    const lines = toCsv([person()]).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("name,profileUrl,userId,phones,emails,whatsapp");
  });

  it("neutralises a display name that a spreadsheet would execute", () => {
    // Every name in this file was written by a stranger. RFC-4180 quoting does not
    // stop Excel evaluating it — the apostrophe prefix does.
    const csv = toCsv([person({ name: "=cmd|'/c calc'!A1" })]);
    expect(csv).toContain(`"'=cmd`);
  });

  it("keeps the leading + on an E.164 number readable to Excel", () => {
    const csv = toCsv([person()]);
    // `+` is a formula lead, so the same prefix protects it from being mangled.
    expect(csv).toContain(`"'+966551234567"`);
  });

  it("survives a person with no contact details", () => {
    const csv = toCsv([person({ contacts: [], bestConfidence: 0 })]);
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("joins multiple posts and reactions without breaking the row", () => {
    const csv = toCsv([
      person({
        sightings: [
          { source: "post.reactor", postUrl: "https://fb/p/1", feedbackId: "1", reaction: "Like", capturedAt: 0 },
          { source: "post.reactor", postUrl: "https://fb/p/2", feedbackId: "2", reaction: "Love", capturedAt: 0 },
        ],
      }),
    ]);
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain("Like | Love");
  });
});

describe("toPhoneCsv", () => {
  it("writes one row per number, not per person", () => {
    const two = person({
      contacts: [
        { kind: "phone", value: "+966551111111", confidence: 0.9, raw: "a" },
        { kind: "phone", value: "+966552222222", confidence: 0.8, raw: "b", whatsapp: true },
        { kind: "email", value: "x@y.com", confidence: 0.9, raw: "x@y.com" },
      ],
    });
    const lines = toPhoneCsv([two]).split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 phones, email excluded
    expect(lines[2]).toContain("yes"); // whatsapp column
  });

  it("emits only a header when nobody has a number", () => {
    expect(toPhoneCsv([person({ contacts: [] })]).split("\r\n")).toHaveLength(1);
  });
});

describe("toJson", () => {
  it("round-trips", () => {
    expect(JSON.parse(toJson([person()]))[0].id).toBe("100001");
  });
});

describe("whatsappLink", () => {
  it("strips the plus and every separator", () => {
    expect(whatsappLink("+966 55-123 4567")).toBe("https://wa.me/966551234567");
  });

  it("attaches an encoded prefilled message", () => {
    const link = whatsappLink("+966551234567", "مرحبا {{name}}", { name: "عمر" });
    expect(link).toContain("?text=");
    expect(decodeURIComponent(link.split("text=")[1]!)).toBe("مرحبا عمر");
  });

  it("omits the query when there is no template", () => {
    expect(whatsappLink("+966551234567")).not.toContain("?");
  });
});

describe("fillTemplate", () => {
  it("substitutes known placeholders", () => {
    expect(fillTemplate("Hi {{name}}, re {{group}}", { name: "A", group: "B" })).toBe("Hi A, re B");
  });

  it("leaves an unknown placeholder standing rather than blanking it", () => {
    // "Hi {{name}}" is a mistake the operator catches; "Hi ," looks deliberate and gets sent.
    expect(fillTemplate("Hi {{name}}", {})).toBe("Hi {{name}}");
  });

  it("is a no-op on text with no placeholders", () => {
    expect(fillTemplate("مرحبا", { name: "x" })).toBe("مرحبا");
  });
});
