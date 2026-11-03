import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themePreloadScript } from "../src/dashboard/lib/theme.js";

/**
 * Both HTML entry points load the pre-paint theme snippet from `public/theme-preload.js`.
 *
 * They used to inline it, which was wrong in a way no test caught: MV3 extension pages
 * run under `script-src 'self'`, so an inline script is not merely discouraged — Chrome
 * refuses to execute it, and the page renders in the wrong theme with a CSP error in the
 * console. The "no inline script" check below is the one that would have caught it.
 *
 * A classic external `<script src>` still executes before first paint, so nothing about
 * the no-flash behaviour changed.
 */

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(EXT, "src");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

const PAGES = [
  ["dashboard", "dashboard/index.html"],
  ["popup", "popup/index.html"],
] as const;

const tokens = read("dashboard/tokens.css");

/**
 * The HTML ground colour is a literal hex, because it has to apply before any
 * stylesheet (and therefore any custom property) exists. Tokens are stored as
 * channels, so convert before comparing.
 */
const surfaceOf = (selector: string) => {
  const block = tokens.slice(tokens.indexOf(selector), tokens.indexOf("}", tokens.indexOf(selector)));
  const channels = /--md-sys-color-surface:\s*([^;]+);/.exec(block)?.[1];
  if (!channels) return undefined;
  return `#${channels
    .split(" ")
    .map((c) => Number(c).toString(16).padStart(2, "0"))
    .join("")}`;
};

describe("public/theme-preload.js", () => {
  const preload = readFileSync(resolve(EXT, "public/theme-preload.js"), "utf8");

  it("carries the snippet verbatim from lib/theme.ts", () => {
    // If this fails, lib/theme.ts changed and the shipped copy was not regenerated.
    expect(preload).toContain(themePreloadScript());
  });

  it("is a classic script, not a module", () => {
    // A module would be deferred, and a deferred theme is a visible flash.
    expect(preload).not.toMatch(/\b(import|export)\b/);
  });
});

describe.each(PAGES)("%s/index.html", (_name, path) => {
  const html = read(path);

  it("loads the pre-paint theme from the extension root", () => {
    expect(html).toContain('<script src="/theme-preload.js"></script>');
  });

  it("contains no inline script — MV3 blocks them outright", () => {
    // `script-src 'self'` means an inline <script> is dead code that also logs a CSP
    // error. This is the assertion that stops one coming back.
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline.map((m) => m[1]?.trim()).filter(Boolean)).toEqual([]);
  });

  it("loads no remote origin", () => {
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("grounds both schemes with the real surface colours", () => {
    expect(html).toContain(`html { background: ${surfaceOf(":root {")}; }`);
    expect(html).toContain(`html.dark { background: ${surfaceOf(".dark {")}; }`);
  });
});
