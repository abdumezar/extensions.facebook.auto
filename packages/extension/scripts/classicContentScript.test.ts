import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SCRIPT_FILE, classicContentScript } from "./lib/classicContentScript.js";

/**
 * A content script that imports a chunk gets a loader from the build, and the loader has to
 * be web-accessible so the page can fetch it. The content script is therefore built on its
 * own as one classic script: nothing to import, nothing to expose.
 */

const scripts = [{ matches: ["*://*.facebook.com/*"], run_at: "document_idle", all_frames: false }];

describe("classicContentScript plugin", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nashir-content-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function plugin(entrySource: string, helpers: Record<string, string> = {}) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/entry.ts"), entrySource);
    for (const [name, source] of Object.entries(helpers)) writeFileSync(join(root, "src", name), source);
    return classicContentScript({ root, entry: "src/entry.ts", scripts });
  }

  it("runs only in a build, after crxjs", () => {
    const p = plugin("export {};");
    expect(p.apply).toBe("build");
    expect(p.enforce).toBe("post");
  });

  it("points the manifest's content script at the one built file", () => {
    const p = plugin("export {};");
    const result = p.renderCrxManifest({ name: "x" }) as { name: string; content_scripts: Record<string, unknown>[] };
    expect(result.name).toBe("x");
    expect(result.content_scripts).toEqual([{ ...scripts[0], js: [CONTENT_SCRIPT_FILE] }]);
  });

  it("emits a single file with the shared module and the dynamic import inlined", async () => {
    const p = plugin(
      "import { shared } from './shared';\nconst later = () => import('./later');\nchrome.runtime.sendMessage(shared); later();",
      { "shared.ts": "export const shared = 'SHARED_MARKER';", "later.ts": "export const x = 'LATER_MARKER';" },
    );
    const emitted: { fileName: string; source: string }[] = [];
    await (p.generateBundle as unknown as (this: unknown) => Promise<void>).call({
      emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toBe(CONTENT_SCRIPT_FILE);
    const source = emitted[0]!.source;
    expect(source).toContain("SHARED_MARKER");
    expect(source).toContain("LATER_MARKER");
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
  });
});
