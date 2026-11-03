import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { signBytes, signFile, verifyWithRawKey } from "./sign-release.mjs";

/**
 * The release signature is what stops a tampered archive from being installed, and the
 * script that makes it runs in a job with nothing installed. These tests use a key pair
 * made inside the test; nothing here is, or is derived from, a real release key.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sign-release.mjs");

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    rawB64: rawPublicKey(publicKey),
  };
}

const rawPublicKey = (key: KeyObject) =>
  (key.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");

let dir: string;
let zipPath: string;
const zipBytes = Buffer.from("pretend this is a release archive");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nashir-sign-"));
  zipPath = join(dir, "nashir-1.0.0.zip");
  writeFileSync(zipPath, zipBytes);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyWithRawKey", () => {
  it("accepts a good signature and rejects a flipped byte", () => {
    const { publicKey, keyPem, rawB64 } = makeKeys();
    const { sig } = signFile(zipPath, keyPem);
    expect(verifyWithRawKey(zipBytes, sig, rawB64)).toBe(true);

    const tampered = Buffer.from(zipBytes);
    tampered[0] = tampered[0]! ^ 1;
    expect(verifyWithRawKey(tampered, sig, rawB64)).toBe(false);

    const badSig = Buffer.from(sig, "base64");
    badSig[10] = badSig[10]! ^ 1;
    expect(verifyWithRawKey(zipBytes, badSig.toString("base64"), rawB64)).toBe(false);

    // The same raw key must also verify with node's own key object: one wrapping, one meaning.
    expect(verify(null, zipBytes, publicKey, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("rejects the wrong key and anything malformed instead of throwing", () => {
    const signer = makeKeys();
    const other = makeKeys();
    const { sig } = signFile(zipPath, signer.keyPem);
    expect(verifyWithRawKey(zipBytes, sig, other.rawB64)).toBe(false);
    expect(verifyWithRawKey(zipBytes, "", signer.rawB64)).toBe(false);
    expect(verifyWithRawKey(zipBytes, "AAAA", signer.rawB64)).toBe(false);
    expect(verifyWithRawKey(zipBytes, sig, "")).toBe(false);
    expect(verifyWithRawKey(zipBytes, sig, "AAAA")).toBe(false);
    expect(verifyWithRawKey(zipBytes, sig, "%%%")).toBe(false);
  });
});

describe("signFile", () => {
  it("produces a signature that verifies with the public key", () => {
    const { publicKey, keyPem } = makeKeys();
    const { sig, sha256 } = signFile(zipPath, keyPem);

    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(verify(null, zipBytes, publicKey, Buffer.from(sig, "base64"))).toBe(true);
    expect(sha256).toBe(createHash("sha256").update(zipBytes).digest("hex"));
  });
});

describe("signBytes", () => {
  it("signs bytes already in memory, the same way signFile does", () => {
    const { publicKey, keyPem } = makeKeys();
    const { sig, sha256 } = signBytes(zipBytes, keyPem);
    expect(verify(null, zipBytes, publicKey, Buffer.from(sig, "base64"))).toBe(true);
    expect(sha256).toBe(signFile(zipPath, keyPem).sha256);
  });

  it("refuses a key that is not ed25519, naming the type", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => signBytes(zipBytes, rsa.export({ type: "pkcs8", format: "pem" }) as string)).toThrow(/ed25519.*rsa/);
  });

  it("reports text that is not a PEM without echoing it", () => {
    const secret = "do-not-print-this-value";
    let message = "";
    try {
      signBytes(zipBytes, secret);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("RELEASE_SIGNING_KEY is not a PKCS#8 PEM");
    expect(message).not.toContain(secret);
  });
});

describe("sign-release CLI", () => {
  function run(args: string[], env: Record<string, string | undefined>) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
  }

  function keysFile(...keys: string[]) {
    const path = join(dir, "keys.json");
    writeFileSync(path, JSON.stringify(keys));
    return path;
  }

  it("writes <zip>.sig and a SHA256SUMS line next to the zip", () => {
    const { keyPem, rawB64 } = makeKeys();
    const result = run([zipPath, "--keys", keysFile(rawB64)], { RELEASE_SIGNING_KEY: keyPem });
    expect(result.status, result.stderr).toBe(0);

    const sig = readFileSync(`${zipPath}.sig`, "utf8");
    expect(verifyWithRawKey(zipBytes, sig, rawB64)).toBe(true);
    const sha = createHash("sha256").update(zipBytes).digest("hex");
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe(`${sha}  nashir-1.0.0.zip\n`);
  });

  it("keeps one SHA256SUMS line per file when it runs again", () => {
    const { keyPem, rawB64 } = makeKeys();
    const other = join(dir, "nashir-1.0.1.zip");
    writeFileSync(other, "another archive");
    const args = ["--keys", keysFile(rawB64)];
    for (const target of [zipPath, other, zipPath]) {
      expect(run([target, ...args], { RELEASE_SIGNING_KEY: keyPem }).status).toBe(0);
    }
    const lines = readFileSync(join(dir, "SHA256SUMS"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => line.split("  ")[1]).sort()).toEqual(["nashir-1.0.0.zip", "nashir-1.0.1.zip"]);
  });

  it("reads an existing SHA256SUMS with Windows line endings", () => {
    const { keyPem, rawB64 } = makeKeys();
    writeFileSync(
      join(dir, "SHA256SUMS"),
      `${"0".repeat(64)}  nashir-0.9.0.zip\r\n${"1".repeat(64)}  nashir-1.0.0.zip\r\n`,
    );
    expect(run([zipPath, "--keys", keysFile(rawB64)], { RELEASE_SIGNING_KEY: keyPem }).status).toBe(0);
    const lines = readFileSync(join(dir, "SHA256SUMS"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`${"0".repeat(64)}  nashir-0.9.0.zip`);
    expect(lines[1]!.endsWith("  nashir-1.0.0.zip")).toBe(true);
    expect(lines[1]).not.toContain("1".repeat(64));
  });

  it("explains a signing key that is not a PEM, and does not print it", () => {
    const { rawB64 } = makeKeys();
    const result = run([zipPath, "--keys", keysFile(rawB64)], { RELEASE_SIGNING_KEY: "do-not-print-this-value" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RELEASE_SIGNING_KEY is not a PKCS#8 PEM");
    expect(result.stderr + result.stdout).not.toContain("do-not-print-this-value");
  });

  it("refuses to publish a signature the listed keys would not accept", () => {
    const { keyPem } = makeKeys();
    const result = run([zipPath, "--keys", keysFile(makeKeys().rawB64)], { RELEASE_SIGNING_KEY: keyPem });
    expect(result.status).not.toBe(0);
    expect(existsSync(`${zipPath}.sig`)).toBe(false);
    expect(existsSync(join(dir, "SHA256SUMS"))).toBe(false);
  });

  it("fails clearly without the signing key or the archive", () => {
    const { rawB64 } = makeKeys();
    const keys = ["--keys", keysFile(rawB64)];
    const missingKey = run([zipPath, ...keys], {});
    expect(missingKey.status).not.toBe(0);
    expect(missingKey.stderr).toContain("RELEASE_SIGNING_KEY");

    const noArgs = run(keys, { RELEASE_SIGNING_KEY: makeKeys().keyPem });
    expect(noArgs.status).not.toBe(0);
    expect(noArgs.stderr).toContain("Usage");

    const noFile = run([join(dir, "missing.zip"), ...keys], { RELEASE_SIGNING_KEY: makeKeys().keyPem });
    expect(noFile.status).not.toBe(0);
  });
});
