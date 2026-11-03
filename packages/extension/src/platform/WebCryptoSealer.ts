import type { CryptoPort, Sealed } from "../engine/ports/index.js";
import type { StoragePort } from "../engine/ports/index.js";

const DEVICE_SECRET_KEY = "nashir:device-secret";
const KEY_VERSION = 1;

/**
 * CryptoPort backed by WebCrypto AES-GCM.
 *
 * The key is derived (PBKDF2) from a per-install random device secret stored in
 * chrome.storage. This is obfuscation-grade at rest — an extension cannot keep a
 * secret from a determined local attacker with the same profile — documented honestly.
 * An optional user passphrase can be mixed in later for stronger protection.
 */
export class WebCryptoSealer implements CryptoPort {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly storage: StoragePort) {}

  private async getKey(): Promise<CryptoKey> {
    if (this.keyPromise) return this.keyPromise;
    this.keyPromise = (async () => {
      let secret = await this.storage.get<string>(DEVICE_SECRET_KEY);
      if (!secret) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        secret = btoa(String.fromCharCode(...bytes));
        await this.storage.set(DEVICE_SECRET_KEY, secret);
      }
      const enc = new TextEncoder();
      const baseKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: enc.encode("nashir:auth:v1"),
          iterations: 120_000,
          hash: "SHA-256",
        },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    return this.keyPromise;
  }

  async seal(plaintext: string): Promise<Sealed> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    );
    return {
      ct: toB64(new Uint8Array(ct)),
      iv: toB64(iv),
      v: KEY_VERSION,
    };
  }

  async open(sealed: Sealed): Promise<string> {
    const key = await this.getKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.iv) },
      key,
      fromB64(sealed.ct),
    );
    return new TextDecoder().decode(pt);
  }
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function fromB64(b64: string): BufferSource {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
