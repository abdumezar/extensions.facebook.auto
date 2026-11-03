import { describe, expect, it } from "vitest";
import { formatNumber } from "./format.js";

describe("formatNumber", () => {
  it("groups thousands and keeps Latin digits in every language", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "ar")).toBe("1,234,567");
  });

  it("falls back to the default locale for an unusable language tag", () => {
    expect(formatNumber(1234, "not a locale")).toBe((1234).toLocaleString());
    expect(formatNumber(1234, undefined)).toBe((1234).toLocaleString());
  });
});
