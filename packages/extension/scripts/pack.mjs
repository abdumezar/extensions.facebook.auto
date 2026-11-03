/**
 * Package a built extension as a zip.
 *
 *   pnpm pack:ext
 *
 * Run `pnpm build` first — this packages `dist/`, it does not build it. Both folders can
 * be overridden (`--dist <dir> --out <dir>`), which is how the tests run it on a fixture.
 *
 * Besides the built files the archive carries `nashir-files.json`: every path in it,
 * itself included, in UTF-16 code-unit order. The in-extension updater refuses an archive
 * whose list disagrees with its entries, so the order is the default `.sort()` and never
 * a locale-aware one.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZip } from "./lib/zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_LIST = "nashir-files.json";

/** Names Windows reserves as devices, with or without an extension. */
const RESERVED_BASE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The same rule as `isSafeReleasePath` in src/update/applyUpdate.ts, which the updater
 * applies to every entry. Repeated here (this script runs without a TypeScript build) so a
 * bad file name fails the packaging step instead of a user's update.
 */
export function isInstallablePath(path) {
  if (path === "") return false;
  return path.split("/").every((segment) => {
    if (segment === "." || segment === ".." || segment.endsWith(".")) return false;
    if (!SAFE_SEGMENT.test(segment)) return false;
    return !RESERVED_BASE_NAME.test(segment.split(".")[0]);
  });
}

/**
 * What `unpackRelease` also refuses beyond a single path's shape: two paths equal when
 * compared case-insensitively (one file on Windows), and a path that is both a file and
 * the folder of another file.
 *
 * @param {string[]} names
 * @returns {string[]} one message per problem; empty when the tree is fine
 */
export function releasePathProblems(names) {
  const problems = [];
  const seen = new Map();
  for (const name of names) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) problems.push(`${seen.get(folded)} and ${name} differ only by case`);
    else seen.set(folded, name);
  }
  for (const name of names) {
    const parts = name.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (seen.has(parent)) problems.push(`${seen.get(parent)} is a file, but ${name} sits inside it`);
    }
  }
  return problems;
}

/**
 * Web pages can request any web-accessible file. With the extension id pinned that URL would
 * be identical on every machine and prove the extension is installed, so every entry has to
 * use a per-profile dynamic URL. The build sets this; this makes sure it did.
 */
function assertDynamicUrls(manifest) {
  const loose = (manifest.web_accessible_resources ?? []).filter((entry) => entry.use_dynamic_url !== true);
  if (loose.length > 0) {
    throw new Error(
      `Every web_accessible_resources entry needs use_dynamic_url: true; not set on: ${JSON.stringify(loose)}`,
    );
  }
}

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
  return entries;
}

/**
 * @param {{ dist?: string, out?: string }} [options]
 * @returns {Promise<{ zipPath: string, version: string, names: string[], size: number }>}
 */
export async function packRelease({ dist = join(ROOT, "dist"), out = join(ROOT, "release") } = {}) {
  if (!existsSync(dist)) throw new Error("No dist/ — run `pnpm build` first.");

  const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
  const version = manifest.version;
  assertDynamicUrls(manifest);
  const files = await collect(dist);

  if (files.some((file) => file.name === FILE_LIST)) {
    throw new Error(`dist/ already contains ${FILE_LIST}; the packer writes it.`);
  }
  const unsafe = files.filter((file) => !isInstallablePath(file.name));
  if (unsafe.length > 0) {
    throw new Error(`The updater would refuse these file names: ${unsafe.map((file) => file.name).join(", ")}`);
  }

  const problems = releasePathProblems([...files.map((file) => file.name), FILE_LIST]);
  if (problems.length > 0) throw new Error(`The updater would refuse this tree: ${problems.join("; ")}`);

  const names = [...files.map((file) => file.name), FILE_LIST].sort();
  files.push({ name: FILE_LIST, data: Buffer.from(JSON.stringify(names, null, 2) + "\n", "utf8") });
  // Sorted so the same input always produces byte-identical output — a build you cannot
  // reproduce is a build you cannot verify.
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const zip = createZip(files);

  await mkdir(out, { recursive: true });
  const zipPath = join(out, `nashir-${version}.zip`);
  await writeFile(zipPath, zip);
  return { zipPath, version, names, size: zip.length };
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : resolve(argv[index + 1] ?? "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    const { zipPath, names, size } = await packRelease({ dist: option(argv, "--dist"), out: option(argv, "--out") });
    console.log(`zip  ${relative(ROOT, zipPath)}  (${names.length} files, ${kb(size)})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
