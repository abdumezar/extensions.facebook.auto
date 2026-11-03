import keys from "./releaseKeys.json";
import { e2eBuild, type E2eBuild } from "./e2e.js";

/** The release keys, plus the throwaway test key when this is an end-to-end build. */
export function keysFor(releaseKeys: readonly string[], e2e: Pick<E2eBuild, "pubKey"> | null): readonly string[] {
  return e2e ? [...releaseKeys, e2e.pubKey] : [...releaseKeys];
}

/**
 * Raw 32-byte ed25519 public keys, base64. A release signature that verifies against any
 * of them is accepted, so a key can be rotated by listing the new one next to the old.
 */
export const RELEASE_PUBLIC_KEYS_B64: readonly string[] = Object.freeze(keysFor(keys, e2eBuild));
