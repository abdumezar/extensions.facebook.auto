import { describe, it, expect } from "vitest";
import { isNewerVersion } from "./semver.js";

describe("isNewerVersion", () => {
  it("1.0.10 is newer than 1.0.9", () => {
    expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
    expect(isNewerVersion("1.0.9", "1.0.10")).toBe(false);
  });

  it("compares major and minor before patch", () => {
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.1.9")).toBe(true);
    expect(isNewerVersion("1.1.9", "1.2.0")).toBe(false);
  });

  it("v1.1.0 vs 1.1.0 is not newer", () => {
    expect(isNewerVersion("v1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("v1.1.1", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.1.1", "v1.1.0")).toBe(true);
  });

  it("garbage is not newer", () => {
    for (const bad of ["", "latest", "1.0", "1.0.0.1", "1.0.x", "1.0.0-beta", "-1.0.0", "1..0"]) {
      expect(isNewerVersion(bad, "1.0.0")).toBe(false);
      expect(isNewerVersion("9.9.9", bad)).toBe(false);
    }
  });
});
