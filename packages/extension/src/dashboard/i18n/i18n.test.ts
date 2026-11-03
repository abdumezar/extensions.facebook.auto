import { describe, it, expect } from "vitest";
import { ar } from "./ar.js";
import { en } from "./en.js";

/** Flatten a nested resource bundle to dotted keys, so the two can be compared as sets. */
function keysOf(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

/** {{placeholders}} a string interpolates. */
function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort();
}

function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

/**
 * The app is Arabic-first with English as the fallback locale, which means a key missing
 * from `ar` silently renders English mid-sentence rather than failing. These two checks
 * are the only thing standing between a translation slip and that.
 */
describe("translation bundles", () => {
  it("define exactly the same keys in both languages", () => {
    const enKeys = keysOf(en).sort();
    const arKeys = keysOf(ar).sort();

    expect(arKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !arKeys.includes(k))).toEqual([]);
  });

  it("interpolate the same placeholders in both languages", () => {
    const flatEn = flatten(en);
    const flatAr = flatten(ar);

    const mismatched = Object.keys(flatEn).filter(
      (k) =>
        flatAr[k] !== undefined &&
        placeholdersOf(flatEn[k]!).join(",") !== placeholdersOf(flatAr[k]!).join(","),
    );

    expect(mismatched).toEqual([]);
  });

  it("leave no empty strings, which would render as a blank label", () => {
    const empty = Object.entries(flatten(ar))
      .concat(Object.entries(flatten(en)))
      .filter(([, v]) => v.trim() === "")
      .map(([k]) => k);

    expect(empty).toEqual([]);
  });
});
