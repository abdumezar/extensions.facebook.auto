import type { HttpPort } from "../engine/ports/index.js";

/**
 * HttpPort backed by the service worker's fetch. Requests to facebook.com get their
 * Origin/Referer rewritten by the DNR rules (see background/dnrManager) so FB's CSRF
 * checks pass; here we just forward fetch verbatim.
 */
export class ChromeHttp implements HttpPort {
  fetch(input: string, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }
}
