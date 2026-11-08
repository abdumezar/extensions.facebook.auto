import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The Arabic line-height overrides in styles.css are plain CSS, so they only reach the
 * exact class name they are written for: `.text-label-large` is covered, but the
 * `lg:text-label-large` utility is a different class and needs a rule of its own. Without
 * one, that element silently keeps the Latin leading under Arabic and clips diacritics.
 */

const SRC = join(import.meta.dirname, "..");
const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

// A type role behind at least one variant, as written in a class string.
const VARIANT_ROLE = /(?:^|[\s"'`])([\w-]+(?::[\w-]+)*):text-(display|headline|title|body|label)-(large|medium|small)\b/g;

function variantRoles(): string[] {
  const found = new Set<string>();
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
  );
  for (const file of files) {
    for (const m of readFileSync(join(SRC, file), "utf8").matchAll(VARIANT_ROLE)) {
      found.add(`${m[1]}:text-${m[2]}-${m[3]}`);
    }
  }
  return [...found].sort();
}

describe("Arabic leading for variant-prefixed type roles", () => {
  it("finds the variant roles the dashboard uses", () => {
    // Guards the scan itself: an empty list would let the next test pass for nothing.
    expect(variantRoles()).toContain("lg:text-label-large");
  });

  it.each(variantRoles())("styles.css overrides line-height for %s under lang=ar", (cls) => {
    // In a selector every colon of the class name is escaped.
    const selector = "." + cls.replaceAll(":", String.raw`\:`) + " ";
    const lines = css.split(/\r?\n/);
    expect(lines.some((l) => l.includes('[lang="ar"]') && l.includes(selector) && l.includes("line-height"))).toBe(true);
  });
});
