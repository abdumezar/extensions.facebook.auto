import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { verifyReleaseSignature } from "./verify.js";

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const zip = new TextEncoder().encode("pretend this is a release archive");

async function makeKeyPair() {
  const secret = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(secret);
  return { secret, publicB64: toBase64(publicKey) };
}

describe("verifyReleaseSignature", () => {
  it("valid signature verifies", async () => {
    const { secret, publicB64 } = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, secret));
    expect(await verifyReleaseSignature(zip, sig, [publicB64])).toBe(true);
  });

  it("second listed key verifies", async () => {
    const first = await makeKeyPair();
    const second = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, second.secret));
    expect(await verifyReleaseSignature(zip, sig, [first.publicB64, second.publicB64])).toBe(true);
  });

  it("flipped byte fails", async () => {
    const { secret, publicB64 } = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, secret));
    const tampered = zip.slice();
    tampered[0] = tampered[0]! ^ 1;
    expect(await verifyReleaseSignature(tampered, sig, [publicB64])).toBe(false);
  });

  it("wrong key fails", async () => {
    const signer = await makeKeyPair();
    const other = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, signer.secret));
    expect(await verifyReleaseSignature(zip, sig, [other.publicB64])).toBe(false);
  });

  it("malformed base64 returns false", async () => {
    const { publicB64 } = await makeKeyPair();
    expect(await verifyReleaseSignature(zip, "not base64 !!", [publicB64])).toBe(false);
    expect(await verifyReleaseSignature(zip, "", [publicB64])).toBe(false);
    expect(await verifyReleaseSignature(zip, "AAAA", [publicB64])).toBe(false);
  });

  it("a malformed key does not hide a good one", async () => {
    const { secret, publicB64 } = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, secret));
    expect(await verifyReleaseSignature(zip, sig, ["%%%", "AAAA", publicB64])).toBe(true);
  });

  it("an empty key list verifies nothing", async () => {
    const { secret } = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, secret));
    expect(await verifyReleaseSignature(zip, sig, [])).toBe(false);
  });

  it("a key not in the bundled list verifies nothing", async () => {
    const { secret } = await makeKeyPair();
    const sig = toBase64(await ed.signAsync(zip, secret));
    expect(await verifyReleaseSignature(zip, sig)).toBe(false);
  });
});
