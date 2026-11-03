import { describe, it, expect } from "vitest";
import { RELEASE_PUBLIC_KEYS_B64 } from "./releaseKey.js";

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
