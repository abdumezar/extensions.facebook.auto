import { describe, expect, it } from "vitest";
import { shouldAnnounceUpdate, type InstalledDetails } from "./announce.js";

describe("shouldAnnounceUpdate", () => {
  it("announces when the version changed", () => {
    expect(shouldAnnounceUpdate({ reason: "update", previousVersion: "1.0.0" }, "1.0.1")).toBe(true);
  });

  it("onInstalled with the same version opens nothing", () => {
    expect(shouldAnnounceUpdate({ reason: "update", previousVersion: "1.0.1" }, "1.0.1")).toBe(false);
  });

  it("does not announce a first install or a browser update", () => {
    expect(shouldAnnounceUpdate({ reason: "install" }, "1.0.1")).toBe(false);
    expect(shouldAnnounceUpdate({ reason: "chrome_update" }, "1.0.1")).toBe(false);
  });

  it("does not announce an update without a previous version", () => {
    expect(shouldAnnounceUpdate({ reason: "update" }, "1.0.1")).toBe(false);
  });

  it("narrows previousVersion to a string for the caller", () => {
    const details: InstalledDetails = { reason: "update", previousVersion: "1.0.0" };
    if (shouldAnnounceUpdate(details, "1.0.1")) {
      const previous: string = details.previousVersion;
      expect(previous).toBe("1.0.0");
    } else {
      expect.unreachable();
    }
  });
});
