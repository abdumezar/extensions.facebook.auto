import type { CookiePort, CookieRecord, CookieSpec } from "../engine/ports/index.js";

/** CookiePort backed by chrome.cookies (requires the "cookies" permission). */
export class ChromeCookies implements CookiePort {
  async get(url: string, name: string): Promise<CookieRecord | null> {
    const c = await chrome.cookies.get({ url, name });
    return c ? toRecord(c) : null;
  }

  async getAll(url: string): Promise<CookieRecord[]> {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const cookies = await chrome.cookies.getAll({ domain });
    return cookies.map(toRecord);
  }

  async set(spec: CookieSpec): Promise<void> {
    await chrome.cookies.set({
      url: spec.url,
      name: spec.name,
      value: spec.value,
      domain: spec.domain,
      path: spec.path ?? "/",
      secure: spec.secure ?? true,
      httpOnly: spec.httpOnly ?? false,
      sameSite: spec.sameSite ?? "no_restriction",
      expirationDate: spec.expirationDate,
    });
  }

  async remove(url: string, name: string): Promise<void> {
    await chrome.cookies.remove({ url, name });
  }
}

function toRecord(c: chrome.cookies.Cookie): CookieRecord {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
}
