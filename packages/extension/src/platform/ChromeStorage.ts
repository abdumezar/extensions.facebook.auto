import type { StoragePort } from "../engine/ports/index.js";

/** StoragePort backed by chrome.storage.local. */
export class ChromeStorage implements StoragePort {
  async get<T>(key: string): Promise<T | null> {
    const out = await chrome.storage.local.get(key);
    return (out[key] as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }
  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }
}
