import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const OUT = resolve(process.argv[2]);

const FAMILIES = [
  {
    css: "Roboto:wght@400;500;700",
    slug: "roboto",
    family: "Roboto",
    subsets: ["latin", "latin-ext"],
  },
  {
    css: "IBM+Plex+Sans+Arabic:wght@400;500;600;700",
    slug: "plex-arabic",
    family: "IBM Plex Sans Arabic",
    subsets: ["arabic"],
  },
];

// Each @font-face in the Google CSS is preceded by a `/* subset */` comment.
const BLOCK = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
const pick = (body, prop) =>
  (body.match(new RegExp(`${prop}:\\s*([^;]+);`)) ?? [])[1]?.trim();

const faces = [];

for (const fam of FAMILIES) {
  const res = await fetch(`https://fonts.googleapis.com/css2?family=${fam.css}&display=swap`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`${fam.family}: HTTP ${res.status}`);
  const css = await res.text();

  for (const [, subset, body] of css.matchAll(BLOCK)) {
    if (!fam.subsets.includes(subset)) continue;
    const weight = pick(body, "font-weight");
    const range = pick(body, "unicode-range");
    const url = (body.match(/url\((https:[^)]+)\)/) ?? [])[1];
    if (!weight || !range || !url) throw new Error(`parse failed: ${fam.family} ${subset}`);

    const bin = await fetch(url, { headers: { "User-Agent": UA } });
    if (!bin.ok) throw new Error(`${fam.slug}-${subset}-${weight}: HTTP ${bin.status}`);
    const buf = Buffer.from(await bin.arrayBuffer());

    // Roboto is a variable font: Google serves the SAME payload for every
    // requested weight, differing only in the font-weight descriptor. Store one
    // copy per distinct payload and point several @font-face rules at it.
    const digest = createHash("sha256").update(buf).digest("hex").slice(0, 8);
    faces.push({ family: fam.family, slug: fam.slug, subset, weight, range, digest, buf });
  }
}

// Group by payload, then name each file after the weights it actually serves.
const byDigest = new Map();
for (const f of faces) {
  if (!byDigest.has(f.digest)) byDigest.set(f.digest, []);
  byDigest.get(f.digest).push(f);
}

await mkdir(OUT, { recursive: true });

for (const group of byDigest.values()) {
  const weights = [...new Set(group.map((f) => f.weight))].sort();
  const { slug, subset, buf } = group[0];
  const file = `${slug}-${subset}-${weights.join("-")}.woff2`;
  await writeFile(resolve(OUT, file), buf);
  for (const f of group) f.file = file;
  console.log(`  ${file}  ${(buf.length / 1024).toFixed(1)} KB  (weights ${weights.join(", ")})`);
}

const NL = "\n";

const header = [
  "/*",
  " * Bundled webfonts. Generated — do not edit by hand.",
  " *",
  " * Roboto ................ Apache-2.0   (Latin, latin-ext)",
  " * IBM Plex Sans Arabic .. OFL-1.1      (Arabic)",
  " *",
  " * Each face carries a unicode-range, so the browser picks the right script",
  " * automatically inside a mixed Arabic/Latin line — no JS, no per-element font",
  " * switching. See LICENSE.md.",
  " *",
  " * Roboto is a variable font, so one file backs several weights; the font-weight",
  " * descriptor is what pins the wght axis for each face.",
  " */",
].join(NL);

const rules = faces
  .map((f) =>
    [
      "@font-face {",
      `  font-family: "${f.family}";`,
      "  font-style: normal;",
      `  font-weight: ${f.weight};`,
      "  font-display: swap;",
      `  src: url("./${f.file}") format("woff2");`,
      `  unicode-range: ${f.range};`,
      "}",
    ].join(NL),
  )
  .join(NL + NL);

await writeFile(resolve(OUT, "fonts.css"), header + NL + NL + rules + NL, "utf8");

const total = [...byDigest.values()].reduce((n, g) => n + g[0].buf.length, 0);
console.log(`${NL}${faces.length} faces over ${byDigest.size} files, ${(total / 1024).toFixed(1)} KB total`);
