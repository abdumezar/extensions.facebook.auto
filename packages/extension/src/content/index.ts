import { ContentRequestSchema, type ContentResponse } from "@nashir/shared";
import { scrapeTokens, scrapeProfile, checkHealth } from "./domTokens.js";

/**
 * Content script — runs on facebook.com. Its only job is to answer typed requests
 * from the service worker: scrape fresh session tokens, read c_user, or classify
 * session health. It never posts; posting is done from the SW via fetch + DNR.
 */
function onMessage(
  raw: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: ContentResponse) => void,
): boolean {
  const parsed = ContentRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendResponse({ ok: false, error: "Invalid content request" } satisfies ContentResponse);
    return false;
  }

  const req = parsed.data;
  try {
    switch (req.type) {
      case "SCRAPE_TOKENS": {
        const tokens = scrapeTokens();
        if (!tokens) {
          sendResponse({ ok: false, error: "Not logged in or tokens unavailable" } satisfies ContentResponse);
        } else {
          sendResponse({ ok: true, data: tokens } satisfies ContentResponse);
        }
        return false;
      }
      case "READ_C_USER": {
        const m = document.cookie.match(/c_user=(\d+)/);
        sendResponse({ ok: !!m, data: m?.[1] } satisfies ContentResponse);
        return false;
      }
      case "CHECK_HEALTH": {
        sendResponse({ ok: true, data: { health: checkHealth() } } satisfies ContentResponse);
        return false;
      }
      case "SCRAPE_PROFILE": {
        const profile = scrapeProfile();
        if (!profile) {
          sendResponse({ ok: false, error: "Not logged in" } satisfies ContentResponse);
        } else {
          sendResponse({ ok: true, data: profile } satisfies ContentResponse);
        }
        return false;
      }
    }
  } catch (err) {
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ContentResponse);
  }
  return false;
}

/**
 * The service worker injects this file into Facebook tabs that were already open, and
 * Chrome may have injected it too. Whichever copy runs last owns the page: it removes
 * the listener the earlier one left in the shared window, so exactly one ever answers.
 * A stale flag from an orphaned copy (its extension was reloaded) can throw on removal;
 * that must not stop the new copy from installing itself.
 */
type ContentGuard = { dispose: () => void };
const guarded = globalThis as { __nashirContent?: ContentGuard };
try {
  guarded.__nashirContent?.dispose();
} catch {
  // The previous copy's extension context is gone; there is nothing left to undo.
}
chrome.runtime.onMessage.addListener(onMessage);
guarded.__nashirContent = { dispose: () => chrome.runtime.onMessage.removeListener(onMessage) };
