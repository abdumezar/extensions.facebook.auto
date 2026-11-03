import type { AudienceContact, AudienceSighting, Contact } from "@nashir/shared";
import { describe, expect, it } from "vitest";
import { dedupeSightings, isSuppressed, mergeContacts } from "./AudienceStore.js";

const phone = (value: string, confidence: number, whatsapp = false): Contact => ({
  kind: "phone",
  value,
  confidence,
  raw: value,
  ...(whatsapp ? { whatsapp } : {}),
});

const sighting = (over: Partial<AudienceSighting>): AudienceSighting => ({
  source: "post.commenter",
  postUrl: "https://fb/p/1",
  feedbackId: "111",
  capturedAt: 0,
  ...over,
});

describe("mergeContacts", () => {
  it("keeps the higher-confidence sighting of the same number", () => {
    const out = mergeContacts([phone("+966551234567", 0.75)], [phone("+966551234567", 0.98, true)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.98);
    expect(out[0]?.whatsapp).toBe(true);
  });

  it("does not downgrade an existing contact", () => {
    const out = mergeContacts([phone("+966551234567", 0.98)], [phone("+966551234567", 0.5)]);
    expect(out[0]?.confidence).toBe(0.98);
  });

  it("unions distinct values, best first", () => {
    const out = mergeContacts([phone("+9665111", 0.5)], [phone("+9665222", 0.9)]);
    expect(out.map((c) => c.value)).toEqual(["+9665222", "+9665111"]);
  });

  it("is a no-op when there is nothing new", () => {
    const existing = [phone("+9665111", 0.8)];
    expect(mergeContacts(existing, [])).toEqual(existing);
  });
});

describe("dedupeSightings", () => {
  it("collapses a re-extraction of the same comment", () => {
    const a = sighting({ commentId: "c1", text: "old" });
    const b = sighting({ commentId: "c1", text: "edited" });
    const out = dedupeSightings([a, b]);
    expect(out).toHaveLength(1);
    // Later wins: a re-extraction has the fresher text.
    expect(out[0]?.text).toBe("edited");
  });

  it("treats a reactor sighting as one per post", () => {
    const a = sighting({ source: "post.reactor", reaction: "Like" });
    const b = sighting({ source: "post.reactor", reaction: "Love" });
    expect(dedupeSightings([a, b])).toHaveLength(1);
    expect(dedupeSightings([a, b])[0]?.reaction).toBe("Love");
  });

  it("keeps a reaction and a comment on the same post as two sightings", () => {
    const out = dedupeSightings([
      sighting({ source: "post.reactor" }),
      sighting({ source: "post.commenter", commentId: "c1" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps the same person's sightings on different posts", () => {
    const out = dedupeSightings([
      sighting({ feedbackId: "111", commentId: "c1" }),
      sighting({ feedbackId: "222", commentId: "c2" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("sorts newest comment first", () => {
    const out = dedupeSightings([
      sighting({ commentId: "old", createdAt: 100 }),
      sighting({ commentId: "new", createdAt: 900 }),
    ]);
    expect(out[0]?.commentId).toBe("new");
  });
});

describe("isSuppressed", () => {
  const row = (over: Partial<AudienceContact>): AudienceContact => ({
    id: "u1",
    name: "A",
    contacts: [],
    sightings: [],
    bestConfidence: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...over,
  });

  it("matches on the profile id", () => {
    expect(isSuppressed(row({}), new Set(["u1"]))).toBe(true);
  });

  it("also matches on a number, so one person under two profiles is caught once", () => {
    expect(isSuppressed(row({ contacts: [phone("+9665111", 1)] }), new Set(["+9665111"]))).toBe(true);
  });

  it("passes anyone not listed", () => {
    expect(isSuppressed(row({ contacts: [phone("+9665111", 1)] }), new Set(["+9665999"]))).toBe(false);
    expect(isSuppressed(row({}), new Set())).toBe(false);
  });
});
