/**
 * What `vite build --mode e2e` changes. The end-to-end script (scripts/e2e-update.mjs)
 * builds two versions of the extension that trust a throwaway key and ask a releases server
 * on this machine, which is how the whole update flow is exercised without publishing a
 * release. None of this is read in any other mode.
 */

/** Present in an end-to-end bundle and nowhere else; the release workflow refuses a `dist` that has it. */
export const E2E_MARKER = "NASHIR_E2E_BUILD";

const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+\//;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

type Env = Record<string, string | undefined>;

export interface E2eInjection {
  marker: string;
  pubKey: string;
  api: string;
}

/** The value of the `__NASHIR_E2E__` global: the test key (raw, base64) and the releases URL. */
export function e2eInjection(env: Env): E2eInjection {
  const pubKey = env["NASHIR_E2E_PUBKEY"];
  const api = env["NASHIR_E2E_API"];
  if (!pubKey) throw new Error("An e2e build needs NASHIR_E2E_PUBKEY (the throwaway public key, base64).");
  if (!api) throw new Error("An e2e build needs NASHIR_E2E_API (the local releases URL).");
  if (!LOCAL_ORIGIN.test(api)) throw new Error("NASHIR_E2E_API must be an http://127.0.0.1:<port>/ address.");
  return { marker: E2E_MARKER, pubKey, api };
}

/** The manifest of an end-to-end build: the version it was asked for, and the local host permission. */
export function e2eManifest<T extends { version: string; host_permissions: string[] }>(base: T, env: Env): T {
  const version = env["NASHIR_E2E_VERSION"];
  if (version !== undefined && !PLAIN_VERSION.test(version)) {
    throw new Error("NASHIR_E2E_VERSION must be three plain numbers, like 1.0.1.");
  }
  return {
    ...base,
    version: version ?? base.version,
    host_permissions: [...base.host_permissions, "http://127.0.0.1/*"],
  };
}
