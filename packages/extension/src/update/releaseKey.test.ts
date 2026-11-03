import { describe, it, expect } from "vitest";
import { RELEASE_PUBLIC_KEYS_B64 } from "./releaseKey.js";

describe("RELEASE_PUBLIC_KEYS_B64", () => {
  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(RELEASE_PUBLIC_KEYS_B64)).toBe(true);
  });
});
