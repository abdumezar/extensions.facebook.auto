/**
 * What an end-to-end build (`vite build --mode e2e`) injects, and nothing else: a throwaway
 * public key and the address of a local releases server. Production and test builds never
 * define it, so this is `null` there and every use folds away.
 */
export interface E2eBuild {
  /** Names the build as a test build; logged at startup so it is in the bundle and in the log. */
  marker: string;
  pubKey: string;
  api: string;
}

declare const __NASHIR_E2E__: E2eBuild | null;

// The guard is for the test runner, which does not apply the build's `define`.
export const e2eBuild: E2eBuild | null = typeof __NASHIR_E2E__ === "undefined" ? null : __NASHIR_E2E__;
