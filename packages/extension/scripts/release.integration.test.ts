import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unpackRelease } from "../src/update/unpack.js";
import { verifyReleaseSignature } from "../src/update/verify.js";
import manifestConfig from "../manifest.config.js";
import pkg from "../package.json";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { packRelease } from "./pack.mjs";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { signFile } from "./sign-release.mjs";

/**
 * What the updater will actually be handed: an archive made by the real packer, signed
 * by the real signer, read back by the code that runs in the extension. Unit tests on
 * each piece cannot catch the pieces disagreeing with each other.
 */

let root: string;
let dist: string;

function put(name: string, data: string) {
  const path = join(dist, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nashir-release-"));
  dist = join(root, "dist");
  put("manifest.json", JSON.stringify({ name: "Nashir", version: "1.0.0", key: "AAAA" }));
  put("loader.js", "import './assets/main.js';");
  put("assets/Index-Ab_1.js", "export {};");
  put("assets/index.ts-Cd-2.js.map", "{}");
  put("src/dashboard/index.html", "<!doctype html>");
  put("_locales/ar/messages.json", "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a packed release", () => {
  it("is accepted by unpackRelease", async () => {
    const { zipPath } = await packRelease({ dist, out: join(root, "release") });
    const unpacked = unpackRelease(new Uint8Array(readFileSync(zipPath)));

    expect(unpacked.manifest).toEqual({ version: "1.0.0", key: "AAAA" });
    expect(unpacked.fileList).toEqual([...unpacked.files.keys()].sort());
    expect(unpacked.fileList).toContain("nashir-files.json");
    expect(new TextDecoder().decode(unpacked.files.get("assets/Index-Ab_1.js"))).toBe("export {};");
  });

  it("carries a signature that the extension's verifier accepts, and only for these bytes", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const { zipPath } = await packRelease({ dist, out: join(root, "release") });

    const { sig } = signFile(zipPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const zip = new Uint8Array(readFileSync(zipPath));
    expect(await verifyReleaseSignature(zip, sig, [rawB64])).toBe(true);

    const tampered = zip.slice();
    tampered[tampered.length - 30] = tampered[tampered.length - 30]! ^ 1;
    expect(await verifyReleaseSignature(tampered, sig, [rawB64])).toBe(false);
  });
});

describe("the extension identity", () => {
  const manifest = manifestConfig as unknown as {
    key: string;
    version: string;
    host_permissions: string[];
    web_accessible_resources?: { resources: string[]; matches: string[]; use_dynamic_url?: boolean }[];
  };

  /** Chrome's own derivation: the first 16 bytes of SHA-256 over the DER key, as a-p. */
  const extensionId = (keyB64: string) =>
    createHash("sha256")
      .update(Buffer.from(keyB64, "base64"))
      .digest("hex")
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)));

  it("pins the extension id, so an update keeps the install, its data and its permissions", () => {
    expect(extensionId(manifest.key)).toBe("jkfmfkdijopiodgfbdnpkileohkojojk");
  });

  it("takes its version from package.json", () => {
    expect(pkg.version).toBe("1.0.0");
    expect(manifest.version).toBe(pkg.version);
  });

  it("asks for Facebook and the GitHub hosts that serve the update, and nothing else", () => {
    expect(manifest.host_permissions).toEqual([
      "*://*.facebook.com/*",
      "*://upload.facebook.com/*",
      "https://api.github.com/*",
      "https://github.com/*",
      "https://objects.githubusercontent.com/*",
      "https://release-assets.githubusercontent.com/*",
    ]);
  });

  it("does not hand the dashboard page to facebook.com", () => {
    const exposed = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources);
    expect(exposed.some((resource) => resource.includes("dashboard"))).toBe(false);
    for (const entry of manifest.web_accessible_resources ?? []) expect(entry.use_dynamic_url).toBe(true);
  });
});
