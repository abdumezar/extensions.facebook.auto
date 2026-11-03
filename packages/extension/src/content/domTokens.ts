import type { SessionTokens, AccountHealth, FbProfile } from "@nashir/shared";

/**
 * Token scraping strategies, run in the content-script context on a loaded
 * facebook.com page. FB rotates these constantly, so we try several sources and
 * return the first complete, valid set.
 */

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Search inline <script> JSON and known globals for a keyed value. */
function findInScripts(patterns: RegExp[]): string | null {
  const html = document.documentElement.innerHTML;
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function scrapeTokens(): SessionTokens | null {
  const cUser = readCookie("c_user");
  if (!cUser) return null; // not logged in

  const fb_dtsg =
    findInScripts([
      /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
      /"dtsg":\{"token":"([^"]+)"/,
      /name="fb_dtsg"\s+value="([^"]+)"/,
      /\["DTSGInitData",\[\],\{"token":"([^"]+)"/,
    ]) ?? "";

  const lsd =
    findInScripts([
      /"LSD",\[\],\{"token":"([^"]+)"/,
      /name="lsd"\s+value="([^"]+)"/,
    ]) ?? "";

  const jazoest = computeJazoest(fb_dtsg);

  const spinR = findInScripts([/"__spin_r":(\d+)/, /"__spin_r":"(\d+)"/]) ?? "";
  const spinB = findInScripts([/"__spin_b":"([^"]+)"/]) ?? "trunk";
  const spinT = findInScripts([/"__spin_t":(\d+)/, /"__spin_t":"(\d+)"/]) ?? "";
  const hasteSession = findInScripts([/"haste_session":"([^"]+)"/]) ?? undefined;

  if (!fb_dtsg) return null;

  return {
    fb_dtsg,
    jazoest,
    lsd,
    user: cUser,
    av: cUser,
    spinR,
    spinB,
    spinT,
    cometReq: "1",
    hasteSession,
    scrapedAt: Date.now(),
  };
}

/** jazoest is a simple checksum FB derives from fb_dtsg. */
function computeJazoest(dtsg: string): string {
  let sum = 0;
  for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
  return "2" + sum;
}

/**
 * Read the logged-in user's name, avatar and profile URL off the page.
 *
 * Facebook ships all three in inline bootstrap JSON, so this needs no API call and no
 * navigation. Name comes from CurrentUserInitialData; the avatar is whichever
 * profile-picture URI the page happens to carry, which is CDN-signed and expires —
 * callers re-scrape rather than caching it indefinitely.
 */
export function scrapeProfile(): FbProfile | null {
  const fbUserId = readCookie("c_user");
  if (!fbUserId) return null;

  const name =
    decodeJsonString(
      findInScripts([
        /"CurrentUserInitialData",\[\],\{[^}]*?"NAME":"((?:[^"\\]|\\.)*)"/,
        /"USER_ID":"\d+","NAME":"((?:[^"\\]|\\.)*)"/,
      ]),
    ) ?? undefined;

  const avatarUrl =
    decodeJsonString(
      findInScripts([
        // The viewer's own actor image, as the comet chrome renders it.
        /"profile_picture(?:_for_sticky_bar)?":\{"uri":"((?:[^"\\]|\\.)*)"/,
        /"profilePicLarge":\{"uri":"((?:[^"\\]|\\.)*)"/,
        /"profilePicSmall":\{"uri":"((?:[^"\\]|\\.)*)"/,
      ]),
    ) ?? findAvatarInDom(fbUserId);

  const vanity = decodeJsonString(findInScripts([/"userVanity":"((?:[^"\\]|\\.)*)"/]));

  return {
    fbUserId,
    name,
    avatarUrl: avatarUrl ?? undefined,
    profileUrl: `https://www.facebook.com/${vanity || fbUserId}`,
  };
}

/**
 * Fallback avatar source: the account-switcher image, which Facebook renders with the
 * viewer's id in its alt/aria text or as a plain profile-photo CDN path.
 */
function findAvatarInDom(fbUserId: string): string | null {
  const selectors = [
    `image[*|href*="${fbUserId}"]`,
    `img[src*="/${fbUserId}_"]`,
    'svg[aria-label] image[*|href*="scontent"]',
    'img[src*="t39.30808-1"]',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      const url =
        el?.getAttribute("xlink:href") ?? el?.getAttribute("href") ?? el?.getAttribute("src");
      if (url?.startsWith("http")) return url;
    } catch {
      /* an unsupported selector must not sink the whole scrape */
    }
  }
  return null;
}

/** Inline JSON is escaped (م, \/, \") — turn one captured value back into text. */
function decodeJsonString(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Checkpoint copy, matched against RENDERED TEXT ONLY.
 *
 * Never against `innerHTML`. Facebook's own bundle names its checkpoint routes in
 * inline script and JSON on essentially every page, so an innerHTML match reports
 * "checkpoint" for a perfectly healthy session — which is worse than missing one,
 * because it is the probe that decides whether a hold may be lifted. That bug made
 * "I've finished the check" impossible to satisfy: the answer was always "still
 * blocked", on every page, forever.
 */
const CHECKPOINT_TEXT = [
  "confirm your identity",
  "confirm it is you",
  "we need to confirm",
  "please confirm your account",
  "تأكيد هويتك",
  "تأكيد أنه أنت",
];

const LOGGED_OUT_TEXT = ["you must log in", "log into facebook", "تسجيل الدخول إلى فيسبوك"];

/** What the user can actually see, lower-cased and bounded. Scripts are not in here. */
function visibleText(): string {
  const body = document.body;
  const text = body ? (body.innerText ?? body.textContent ?? "") : "";
  // A checkpoint interstitial is a short page; anything past this is a loaded feed and
  // reading further only invites false positives.
  return text.slice(0, 20_000).toLowerCase();
}

/**
 * Classify the current page's session health.
 *
 * The URL is the reliable signal and is checked first — Facebook serves a checkpoint at
 * a `/checkpoint/` path. Visible text is the fallback for interstitials rendered in
 * place, and is deliberately matched on specific sentences rather than the bare word
 * "checkpoint", which is far too common to mean anything on its own.
 */
export function checkHealth(): AccountHealth {
  const cUser = readCookie("c_user");
  if (!cUser) return "logged_out";

  const url = location.href.toLowerCase();
  if (/\/checkpoint(\/|\?|$)/.test(url)) return "checkpoint";
  if (/\/login(\/|\.php|\?|$)/.test(url)) return "logged_out";

  const text = visibleText();
  if (CHECKPOINT_TEXT.some((p) => text.includes(p))) return "checkpoint";
  if (LOGGED_OUT_TEXT.some((p) => text.includes(p))) return "logged_out";
  return "ok";
}

