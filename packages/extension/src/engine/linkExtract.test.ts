import { describe, it, expect } from "vitest";
import { displayHost, extractLinks, trimUrl } from "./linkExtract.js";

describe("trimUrl", () => {
  it("drops a sentence-ending period that is not part of the address", () => {
    expect(trimUrl("https://example.com/page.")).toBe("https://example.com/page");
  });

  it("drops an Arabic comma or full stop", () => {
    expect(trimUrl("https://example.com/a،")).toBe("https://example.com/a");
    expect(trimUrl("https://example.com/a؛")).toBe("https://example.com/a");
  });

  it("keeps a closing bracket that the URL opened", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(trimUrl(url)).toBe(url);
  });

  it("drops a closing bracket the URL never opened", () => {
    expect(trimUrl("https://example.com/a)")).toBe("https://example.com/a");
  });
});

describe("extractLinks", () => {
  it("finds a link inside Arabic text and stops at the Arabic punctuation", () => {
    const links = extractLinks(["اطّلع على العرض هنا https://example.com/عرض، وشاركه مع أصدقائك."]);
    expect(links).toEqual(["https://example.com/عرض"]);
  });

  it("preserves reading order across variations and drops duplicates", () => {
    const links = extractLinks([
      "first https://a.example.com then https://b.example.com",
      "again https://a.example.com and https://c.example.com",
    ]);
    expect(links).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });

  it("treats URLs differing only by a tracking parameter as distinct", () => {
    // Facebook builds a different card per URL, so collapsing these would silently
    // change which link the campaign attaches.
    const links = extractLinks(["https://x.example.com/p?utm=a https://x.example.com/p?utm=b"]);
    expect(links).toHaveLength(2);
  });

  it("ignores bare domains, which in Arabic prose are usually not links at all", () => {
    expect(extractLinks(["زوروا example.com اليوم"])).toEqual([]);
  });

  it("ignores something that merely looks like a scheme", () => {
    expect(extractLinks(["https://", "http://nodot", "https://a"])).toEqual([]);
  });

  it("returns nothing for captions with no links", () => {
    expect(extractLinks(["عرض خاص لهذا الأسبوع", ""])).toEqual([]);
  });
});

describe("displayHost", () => {
  it("strips www so two links from one site do not look different", () => {
    expect(displayHost("https://www.example.com/a")).toBe("example.com");
    expect(displayHost("https://shop.example.com/a")).toBe("shop.example.com");
  });

  it("falls back to the raw string rather than throwing", () => {
    expect(displayHost("not a url")).toBe("not a url");
  });
});
