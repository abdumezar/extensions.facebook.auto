import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { EXTENSION_KEY } from "../src/update/extensionKey.js";

/**
 * Builds the extension for real, into a scratch folder, and reads back what Chrome will
 * load. A content script that imports a chunk needs a loader and a web-accessible entry on
 * facebook.com; the page can then tell the extension is installed, and if the entry is
 * dynamic the loader cannot fetch its own chunk. So the file must be a plain script.
 */

type Manifest = {
  key?: string;
  content_scripts: { matches: string[]; js: string[]; run_at: string }[];
  web_accessible_resources?: { matches: string[]; resources: string[] }[];
};

let outDir: string;
let manifest: Manifest;

const read = (name: string) => readFileSync(join(outDir, name), "utf8");

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, base) : [full.slice(base.length + 1).split("\\").join("/")];
  });
}

// Variables an end-to-end run sets. A normal build has to ignore them even when they are
// still in the shell it runs from.
const E2E_ENV = {
  NASHIR_E2E_VERSION: "9.9.9",
  NASHIR_E2E_PUBKEY: "dGhyb3dhd2F5LWtleS1mb3ItdGhlLWUyZS10ZXN0cw==",
  NASHIR_E2E_API: "http://127.0.0.1:45871/releases/latest",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [name, value] of Object.entries(E2E_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  outDir = mkdtempSync(join(tmpdir(), "nashir-build-"));
  await build({
    configFile: resolve(import.meta.dirname, "../vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  manifest = JSON.parse(read("manifest.json")) as Manifest;
}, 180_000);

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(outDir, { recursive: true, force: true });
});

describe("the built extension", () => {
  it("runs the facebook.com content script from one file", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    const [script] = manifest.content_scripts;
    expect(script!.matches).toEqual(["*://*.facebook.com/*"]);
    expect(script!.run_at).toBe("document_idle");
    expect(script!.js).toHaveLength(1);
    expect(listFiles(outDir)).toContain(script!.js[0]);
  });

  it("pins the extension id with the key the updater checks releases against", () => {
    expect(manifest.key).toBe(EXTENSION_KEY);
  });

  it("makes nothing on facebook.com able to request a file of the extension", () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("builds that file as a classic script: no import, no dynamic import, no loader", () => {
    const source = read(manifest.content_scripts[0]!.js[0]!);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/^\s*(import|export)\b/m);
    expect(source).not.toMatch(/\bimport\b\s*[{*"'\w]/);
    expect(source).not.toMatch(/import\.meta/);
    expect(source).not.toContain("chrome.runtime.getURL(");
  });

  it("still answers the typed requests from the service worker", () => {
    const source = read(manifest.content_scripts[0]!.js[0]!);
    expect(source).toContain("onMessage.addListener");
    for (const type of ["SCRAPE_TOKENS", "READ_C_USER", "CHECK_HEALTH", "SCRAPE_PROFILE"]) expect(source).toContain(type);
  });

  it("leaves no loader or content-script chunk behind", () => {
    expect(listFiles(outDir).filter((file) => /index\.ts-loader/.test(file))).toEqual([]);
  });

  it("carries nothing of the end-to-end build", () => {
    const text = listFiles(outDir)
      .filter((name) => /\.(js|json|html|css|map)$/.test(name))
      .map((name) => ({ name, text: read(name) }));
    for (const needle of ["NASHIR_E2E", "127.0.0.1", E2E_ENV.NASHIR_E2E_PUBKEY]) {
      expect(text.filter((file) => file.text.includes(needle)).map((file) => file.name), needle).toEqual([]);
    }
    const { version, host_permissions } = JSON.parse(read("manifest.json")) as { version: string; host_permissions: string[] };
    expect(version).not.toBe(E2E_ENV.NASHIR_E2E_VERSION);
    expect(host_permissions.filter((pattern) => pattern.includes("127.0.0.1"))).toEqual([]);
  });

  it("asks the GitHub releases address for updates", () => {
    const code = listFiles(outDir)
      .filter((name) => name.endsWith(".js"))
      .map(read)
      .join("\n");
    expect(code).toContain("https://api.github.com/repos/abdumezar/extensions.facebook.auto/releases/latest");
  });
});
