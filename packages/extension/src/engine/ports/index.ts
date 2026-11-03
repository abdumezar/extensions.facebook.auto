import type { ContentRequest, ContentResponse } from "@nashir/shared";

/**
 * Ports: the ONLY surface the engine depends on. Platform adapters (src/platform)
 * implement these against chrome.*; tests implement them with in-memory fakes.
 * The engine never imports `chrome`.
 */

export interface CookieSpec {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface CookiePort {
  get(url: string, name: string): Promise<CookieRecord | null>;
  getAll(url: string): Promise<CookieRecord[]>;
  set(spec: CookieSpec): Promise<void>;
  remove(url: string, name: string): Promise<void>;
}

export interface StoragePort {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ClockPort {
  now(): number;
  /** Schedule a one-shot wake at an absolute epoch-millis time. Alarm-backed. */
  scheduleWake(name: string, atEpochMs: number): Promise<void>;
  clearWake(name: string): Promise<void>;
}

/** Talks to the content script running inside the engine-owned facebook.com tab. */
export interface TabPort {
  /** Ensure a facebook.com tab exists/loaded and return its id. */
  ensureFacebookTab(): Promise<number>;
  /**
   * The id of a facebook.com tab the user already has open, or null. Never creates
   * one — this is what lets background work stay invisible: if no tab is open, the
   * caller skips rather than spawning a tab behind the user's back.
   */
  findFacebookTab(): Promise<number | null>;
  /** Reload the FB tab (used after a cookie swap) and wait until ready. */
  reloadAndWait(tabId: number): Promise<void>;
  /**
   * Close the facebook.com tab **we** opened, if we opened one.
   *
   * A tab the user already had is never touched — closing someone's Facebook out from
   * under them would be the most obnoxious thing this extension could do. Optional so
   * every existing fake TabPort in the tests keeps compiling.
   */
  releaseOwnedTab?(): Promise<void>;
  /** Send a typed request to the content script in a tab. */
  callContent<T>(tabId: number, msg: ContentRequest): Promise<ContentResponse<T>>;
}

export interface HttpPort {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface Sealed {
  ct: string;
  iv: string;
  v: number;
}

export interface CryptoPort {
  seal(plaintext: string): Promise<Sealed>;
  open(sealed: Sealed): Promise<string>;
}

/** Structured logger the engine writes to (surfaced in the dashboard event log). */
export interface LoggerPort {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Everything the engine needs, injected once at service worker startup. */
export interface EnginePorts {
  cookies: CookiePort;
  storage: StoragePort;
  clock: ClockPort;
  tab: TabPort;
  http: HttpPort;
  crypto: CryptoPort;
  logger: LoggerPort;
}
