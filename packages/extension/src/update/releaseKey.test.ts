import { describe, it, expect } from "vitest";
import keys from "./releaseKeys.json";
import { RELEASE_PUBLIC_KEYS_B64, keysFor } from "./releaseKey.js";

describe("RELEASE_PUBLIC_KEYS_B64", () => {
  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(RELEASE_PUBLIC_KEYS_B64)).toBe(true);
  });

  it("lists the release key, as raw 32-byte ed25519 keys in base64", () => {
    expect(RELEASE_PUBLIC_KEYS_B64).toContain("u/e/eqCV7X/QHHi/gKeh0QbbXeUSda3bKxrgy1NHJ8A=");
    for (const key of RELEASE_PUBLIC_KEYS_B64) {
      expect(atob(key)).toHaveLength(32);
    }
  });
});

describe("keysFor", () => {
  it("is just the release keys outside an end-to-end build", () => {
    expect(keysFor(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("appends the throwaway key of an end-to-end build after the release keys", () => {
    expect(keysFor(["a", "b"], { pubKey: "t" })).toEqual(["a", "b", "t"]);
  });

  it("does not trust a test run to carry one: the shipped list is exactly the release keys", () => {
    expect(RELEASE_PUBLIC_KEYS_B64).toEqual(keys);
  });
});
