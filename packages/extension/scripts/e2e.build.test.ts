import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { E2E_MARKER, e2eInjection, e2eManifest } from "./lib/e2eBuild.js";

/**
 * The end-to-end build injects a throwaway key, a local releases address, a version and a
 * local host permission, and only when asked to. The production half of that promise (none
 * of it reaches a normal build) is asserted in build.output.test.ts.
 */

const KEY = "dGhyb3dhd2F5LWtleS1mb3ItdGhlLWUyZS10ZXN0cw==";
const API = "http://127.0.0.1:45871/releases/latest";

describe("e2eInjection", () => {
  it("carries the key and the address, and nothing without both", () => {
    expect(e2eInjection({ NASHIR_E2E_PUBKEY: KEY, NASHIR_E2E_API: API })).toEqual({
      marker: E2E_MARKER,
      pubKey: KEY,
      api: API,
    });
    expect(() => e2eInjection({ NASHIR_E2E_API: API })).toThrow(/NASHIR_E2E_PUBKEY/);
    expect(() => e2eInjection({ NASHIR_E2E_PUBKEY: KEY })).toThrow(/NASHIR_E2E_API/);
  });

  it("only accepts a local address, so a typo cannot point a build at the internet", () => {
    expect(() => e2eInjection({ NASHIR_E2E_PUBKEY: KEY, NASHIR_E2E_API: "https://example.org/releases/latest" })).toThrow(
      /127\.0\.0\.1/,
    );
  });
});

describe("e2eManifest", () => {
  const base = { version: "1.0.0", host_permissions: ["https://github.com/*"] };

  it("overrides the version and adds the local host permission", () => {
    const out = e2eManifest(base, { NASHIR_E2E_VERSION: "1.0.1" });
    expect(out.version).toBe("1.0.1");
    expect(out.host_permissions).toEqual(["https://github.com/*", "http://127.0.0.1/*"]);
  });

  it("keeps the version when none is given, and does not edit its input", () => {
    expect(e2eManifest(base, {}).version).toBe("1.0.0");
    expect(base.host_permissions).toEqual(["https://github.com/*"]);
  });

  it("refuses a version that is not three plain numbers", () => {
    expect(() => e2eManifest(base, { NASHIR_E2E_VERSION: "1.0.1-beta" })).toThrow(/NASHIR_E2E_VERSION/);
  });
});

describe("a real end-to-end build", () => {
  let outDir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = { NASHIR_E2E_VERSION: "1.0.1", NASHIR_E2E_PUBKEY: KEY, NASHIR_E2E_API: API };

  const files = (dir: string, base = dir): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full, base) : [full.slice(base.length + 1).split("\\").join("/")];
    });

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    outDir = mkdtempSync(join(tmpdir(), "nashir-e2e-build-"));
    await build({
      configFile: resolve(import.meta.dirname, "../vite.config.ts"),
      mode: "e2e",
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  }, 180_000);

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(outDir, { recursive: true, force: true });
  });

  it("is the overridden version and may reach the local releases server", () => {
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      version: string;
      host_permissions: string[];
    };
    expect(manifest.version).toBe("1.0.1");
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*");
  });

  it("carries the marker, the test key and the local releases address in its code", () => {
    const code = files(outDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(outDir, name), "utf8"))
      .join("\n");
    expect(code).toContain(E2E_MARKER);
    expect(code).toContain(KEY);
    expect(code).toContain(API);
  });
});
