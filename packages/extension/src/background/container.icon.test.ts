import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../manifest.config.js";
import { LEAD_NOTIFICATION_ICON } from "./container.js";

describe("lead notification icon", () => {
  // A path that is not shipped makes chrome.notifications.create fail, and the alert with it.
  it("is one of the icons the build ships", () => {
    expect(Object.values((manifest as unknown as { icons: Record<string, string> }).icons)).toContain(LEAD_NOTIFICATION_ICON);
    expect(existsSync(resolve(import.meta.dirname, "../..", LEAD_NOTIFICATION_ICON))).toBe(true);
  });
});
