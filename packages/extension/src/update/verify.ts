import * as ed from "@noble/ed25519";
import { RELEASE_PUBLIC_KEYS_B64 } from "./releaseKey.js";

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Whether `sigB64` (a raw 64-byte ed25519 signature, base64) is a valid signature over
 * the zip bytes by any of the listed raw public keys. Anything malformed is just `false`;
 * an empty key list verifies nothing.
 */
export async function verifyReleaseSignature(
  zip: Uint8Array,
  sigB64: string,
  publicKeysB64: readonly string[] = RELEASE_PUBLIC_KEYS_B64,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64(sigB64.trim());
  } catch {
    return false;
  }
  for (const key of publicKeysB64) {
    try {
      if (await ed.verifyAsync(signature, zip, fromBase64(key))) return true;
    } catch {
      // A bad key or signature shape only rules out this key.
    }
  }
  return false;
}
