/**
 * Package a built extension as a zip.
 *
 *   pnpm pack:ext
 *
 * Run `pnpm build` first — this packages `dist/`, it does not build it.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./lib/zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "release");

async function collect(dir, base = dir) {
  const entries = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) {
      entries.push(...(await collect(full, base)));
    } else {
      entries.push({ name: relative(base, full).split("\\").join("/"), data: await readFile(full) });
    }
  }
  // Sorted so the same input always produces byte-identical output — a build you cannot
  // reproduce is a build you cannot verify.
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function main() {
  if (!existsSync(DIST)) {
    console.error("No dist/ — run `pnpm build` first.");
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
  const version = manifest.version;
  const files = await collect(DIST);
  const zip = createZip(files);

  await mkdir(OUT, { recursive: true });
  const zipPath = join(OUT, `nashir-${version}.zip`);
  await writeFile(zipPath, zip);
  console.log(`zip  ${relative(ROOT, zipPath)}  (${files.length} files, ${kb(zip.length)})`);
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;

await main();
