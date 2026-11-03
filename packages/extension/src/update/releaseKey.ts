import keys from "./releaseKeys.json";

/**
 * Raw 32-byte ed25519 public keys, base64. A release signature that verifies against any
 * of them is accepted, so a key can be rotated by listing the new one next to the old.
 */
export const RELEASE_PUBLIC_KEYS_B64: readonly string[] = Object.freeze([...keys]);
