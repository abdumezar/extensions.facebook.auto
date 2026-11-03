/**
 * Pulling URLs out of caption text.
 *
 * Pure and separately tested because the interesting cases are all textual: captions are
 * Arabic-first, so a URL routinely sits inside right-to-left text and ends at an Arabic
 * comma or full stop, and people paste links wrapped in brackets or followed by a
 * sentence-ending period that is not part of the address.
 */

/**
 * Scheme-qualified URLs only. A bare `example.com` is too easily a false positive —
 * Arabic sentences contain plenty of dotted tokens — and Facebook needs a scheme anyway.
 *
 * Arabic characters are deliberately allowed inside the match. Excluding them would end
 * a URL cleanly where Arabic prose resumes, but it would also truncate a perfectly valid
 * Arabic path (`https://ar.wikipedia.org/wiki/مصر`) — which, in an Arabic-first product,
 * is the more common case by far. Whitespace and the trailing-punctuation trim below do
 * the separating instead.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/**
 * Characters that end a sentence rather than a URL. The Arabic comma (،) and semicolon
 * (؛) are here for the same reason as their Latin counterparts, and `)` `]` are trimmed
 * only when unbalanced, so a Wikipedia-style link keeps its closing bracket.
 */
const TRAILING = /[.,;:!?'"«»،؛؟]+$/;

/** Strip punctuation that belongs to the sentence, not the address. */
export function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, "");

  // Balance brackets: "(see https://x.com/a)" ends the URL at the paren, but
  // "https://en.wikipedia.org/wiki/Foo_(bar)" keeps it.
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (url.endsWith(close) && countOf(url, close) > countOf(url, open)) {
      url = url.slice(0, -1);
    }
  }
  return url.replace(TRAILING, "");
}

/**
 * Every distinct link across the caption variations, in the order a reader meets them.
 *
 * Order matters because the UI offers the first one as the default choice, and the first
 * link in the first variation is overwhelmingly the one the campaign is about.
 */
export function extractLinks(texts: string[]): string[] {
  const seen = new Set<string>();
  const links: string[] = [];

  for (const text of texts) {
    for (const match of text.match(URL_PATTERN) ?? []) {
      const url = trimUrl(match);
      if (url.length < 12 || !isParseable(url)) continue;
      // Dedupe on the exact URL: two links differing only by a tracking parameter are
      // genuinely different posts as far as Facebook's card is concerned.
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    }
  }
  return links;
}

/** Domain as a human reads it, for labelling a link the user has to choose between. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isParseable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

function countOf(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}
