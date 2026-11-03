/**
 * Fetches the Material Symbols (Rounded) the UI uses and writes them to
 * `src/dashboard/ui/icons.generated.ts` as raw path data.
 *
 * Run: node scripts/gen-icons.mjs
 *
 * Inlining ~34 paths costs a few KB and avoids shipping a multi-megabyte icon
 * font, a build-time subsetting step, a network round trip, and icon FOUT. The
 * generated union type is what makes `<Icon name="..." />` checkable.
 */
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/dashboard/ui/icons.generated.ts",
);

/** Grouped only for readability; the output is one flat, sorted map. */
const ICONS = [
  // Navigation
  "home",
  "edit_note",
  "groups",
  "key",
  "monitoring",
  "list_alt",
  "settings",
  // Run controls and status
  "schedule",
  "bolt",
  "play_arrow",
  "pause",
  "stop",
  "check_circle",
  "hourglass_empty",
  "cancel",
  // Media
  "image",
  "movie",
  "upload_file",
  "add_photo_alternate",
  "delete",
  // Feedback
  "warning",
  "error",
  "info",
  "close",
  "check",
  // App bar
  "translate",
  "light_mode",
  "dark_mode",
  "contrast",
  // Actions
  "search",
  "refresh",
  "sync",
  "add",
  "edit",
  "person",
  "open_in_new",
  "expand_more",
  "arrow_forward",
  "radio_button_unchecked",
  "select_all",
  "science",
  "shield",
  "speed",
  "tune",
  "logout",
  // Analytics
  "download",
  "bar_chart",
  "trending_up",
];

const SRC = (name) =>
  `https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/${name}/default/24px.svg`;

const entries = [];

for (const name of ICONS.slice().sort()) {
  const res = await fetch(SRC(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const svg = await res.text();

  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);

  if (!viewBox) throw new Error(`${name}: no viewBox`);
  if (!paths.length) throw new Error(`${name}: no path data`);
  // Every Material Symbol is a single compound path; more than one means the
  // asset shape changed and the Icon component's assumptions no longer hold.
  if (paths.length > 1) throw new Error(`${name}: expected 1 path, got ${paths.length}`);
  if (viewBox !== "0 -960 960 960") throw new Error(`${name}: unexpected viewBox ${viewBox}`);

  entries.push([name, paths[0]]);
  console.log(`  ${name.padEnd(18)} ${paths[0].length} chars`);
}

const NL = "\n";
const body = entries.map(([name, d]) => `  ${name}: "${d}",`).join(NL);

const out = [
  "/**",
  " * Material Symbols (Rounded) path data — GENERATED, do not edit by hand.",
  " *",
  " * Regenerate: node scripts/gen-icons.mjs",
  " *",
  " * All symbols share the 0 -960 960 960 viewBox, which is what lets <Icon> size",
  " * them with a single `viewBox` constant. Licensed Apache-2.0 by Google.",
  " */",
  "",
  'export const ICON_VIEW_BOX = "0 -960 960 960";',
  "",
  "export const ICON_PATHS = {",
  body,
  "} as const;",
  "",
  "export type IconName = keyof typeof ICON_PATHS;",
  "",
].join(NL);

await writeFile(OUT, out, "utf8");
console.log(`${NL}wrote ${entries.length} icons to ${OUT}`);
