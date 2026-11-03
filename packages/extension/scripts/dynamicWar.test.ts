import { describe, it, expect } from "vitest";
import { dynamicResourceUrls, withDynamicUrls } from "./lib/dynamicWar.js";

/**
 * With a fixed extension id, a fixed URL for each content-script file would let any web
 * page ask "is this extension installed?". A dynamic URL changes per browser profile.
 */

const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  matches: ["*://*.facebook.com/*"],
  resources: ["assets/a.js"],
  ...extra,
});

describe("withDynamicUrls", () => {
  it("turns on use_dynamic_url for every entry, whatever it said", () => {
    const manifest = withDynamicUrls({
      name: "x",
      web_accessible_resources: [entry(), entry({ use_dynamic_url: false }), entry({ use_dynamic_url: true })],
    }) as { name: string; web_accessible_resources: { use_dynamic_url: boolean; resources: string[] }[] };
    expect(manifest.web_accessible_resources.map((e) => e.use_dynamic_url)).toEqual([true, true, true]);
    expect(manifest.web_accessible_resources[0]!.resources).toEqual(["assets/a.js"]);
    expect(manifest.name).toBe("x");
  });

  it("leaves a manifest without web_accessible_resources alone", () => {
    expect(withDynamicUrls({ name: "x" })).toEqual({ name: "x" });
  });
});

describe("dynamicResourceUrls plugin", () => {
  const plugin = dynamicResourceUrls();

  it("runs after crxjs has written its entries, and only in a build", () => {
    expect(plugin.enforce).toBe("post");
    expect(plugin.apply).toBe("build");
  });

  it("rewrites the manifest crxjs hands every plugin", () => {
    const result = plugin.renderCrxManifest({ web_accessible_resources: [entry({ use_dynamic_url: false })] }) as {
      web_accessible_resources: { use_dynamic_url: boolean }[];
    };
    expect(result.web_accessible_resources[0]!.use_dynamic_url).toBe(true);
  });
});
