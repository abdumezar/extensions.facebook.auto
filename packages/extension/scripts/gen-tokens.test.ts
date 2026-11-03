import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CUSTOM_COLORS, SEED, buildTokensCss } from "./gen-tokens.js";

const TOKENS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/dashboard/tokens.css");
const committed = readFileSync(TOKENS_PATH, "utf8").replace(/\r\n/g, "\n");
const generated = buildTokensCss();

/** All `--md-sys-color-*` names declared inside a given selector block. */
function rolesIn(css: string, selector: string): string[] {
  const block = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
  return [...block.matchAll(/--md-sys-color-([a-z0-9-]+):/g)].map((m) => m[1]!).sort();
}

describe("tokens.css drift guard", () => {
  it("matches a fresh run of the generator", () => {
    // If this fails, tokens.css was hand-edited or the seed changed without a
    // regenerate. Fix: pnpm --filter @nashir/extension gen:tokens
    expect(committed).toBe(generated);
  });

  it("records the seed it was generated from", () => {
    expect(committed).toContain(`Source seed: ${SEED}`);
  });
});

describe("scheme completeness", () => {
  it("defines the same role set in light and dark", () => {
    expect(rolesIn(generated, ":root {")).toEqual(rolesIn(generated, ".dark {"));
  });

  it("covers every M3 role the UI depends on", () => {
    const roles = rolesIn(generated, ":root {");
    for (const required of [
      "primary",
      "on-primary",
      "primary-container",
      "on-primary-container",
      "secondary-container",
      "tertiary",
      "error",
      "on-error",
      "error-container",
      "surface",
      "on-surface",
      "on-surface-variant",
      "surface-container",
      "surface-container-high",
      "surface-container-highest",
      "surface-container-low",
      "surface-container-lowest",
      "outline",
      "outline-variant",
      "inverse-surface",
      "inverse-on-surface",
      "scrim",
    ]) {
      expect(roles).toContain(required);
    }
  });

  it("emits a full four-role family for each custom colour", () => {
    const roles = rolesIn(generated, ":root {");
    for (const { name } of CUSTOM_COLORS) {
      expect(roles).toContain(name);
      expect(roles).toContain(`on-${name}`);
      expect(roles).toContain(`${name}-container`);
      expect(roles).toContain(`on-${name}-container`);
    }
  });

  it("gives every role bare sRGB channels in range", () => {
    // Bare channels, not hex — that is what lets Tailwind compose an alpha
    // (`bg-on-surface/38`) for the M3 disabled treatment.
    const values = [...generated.matchAll(/--md-sys-color-[a-z0-9-]+:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(80);
    for (const v of values) {
      expect(v).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      for (const ch of v.split(" ").map(Number)) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it("keeps light and dark genuinely distinct", () => {
    // A copy-paste bug that emitted the light scheme twice would otherwise pass
    // every check above.
    expect(rolesIn(generated, ":root {").length).toBeGreaterThan(0);
    const light = generated.slice(generated.indexOf(":root {"), generated.indexOf(".dark {"));
    const dark = generated.slice(generated.indexOf(".dark {"));
    expect(light).not.toBe(dark);
    const surface = (css: string) => /--md-sys-color-surface:\s*([^;]+);/.exec(css)?.[1];
    expect(surface(light)).not.toBe(surface(dark));
  });
});

describe("scheme-independent tokens", () => {
  it("defines the shape, elevation, state, and motion scales", () => {
    for (const token of [
      "--md-sys-shape-extra-large",
      "--md-sys-shape-full",
      "--md-sys-elevation-3",
      "--md-sys-state-hover",
      "--md-sys-state-disabled-content",
      "--md-sys-easing-emphasized",
      "--md-sys-duration-medium2",
    ]) {
      expect(generated).toContain(token);
    }
  });
});
