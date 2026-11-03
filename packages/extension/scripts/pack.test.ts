import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { createZip, crc32 } from "./lib/zip.mjs";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { packRelease, isInstallablePath, releasePathProblems } from "./pack.mjs";
import { isSafeReleasePath } from "../src/update/applyUpdate.js";

/**
 * Packaging is the last step before someone installs the extension, and the zip writer
 * is hand-written. A malformed archive fails at install time with a useless message, so
 * the structure is asserted rather than eyeballed.
 */

const entries = [
  { name: "manifest.json", data: Buffer.from('{"name":"Nashir","version":"1.0.0"}', "utf8") },
  { name: "assets/app.js", data: Buffer.from("console.log('x');".repeat(200), "utf8") },
  { name: "_locales/ar/messages.json", data: Buffer.from('{"ناشر":"ناشر"}', "utf8") },
];

/** Whichever of `python` / `python3` runs on this machine. */
function pythonCommand(): string {
  for (const cmd of ["python", "python3"]) {
    if (spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0) return cmd;
  }
  throw new Error("Neither python nor python3 is available; the zip cross-check needs one.");
}

describe("crc32", () => {
  it("matches the known value for the standard check string", () => {
    // The canonical CRC-32 test vector: "123456789" => 0xCBF43926.
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });
});

describe("createZip", () => {
  it("writes a recognisable archive with the right entry count", () => {
    const zip: Buffer = createZip(entries);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304"); // local file header
    // End-of-central-directory records the count twice; both must agree.
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 8)).toBe(entries.length);
    expect(zip.readUInt16LE(eocd + 10)).toBe(entries.length);
  });

  it("is byte-identical for identical input, so a build can be reproduced", () => {
    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });

  it("compresses what benefits and stores what does not", () => {
    const compressible = createZip([{ name: "a", data: Buffer.alloc(5000, 97) }]);
    // method lives at offset 8 of the local header: 8 = deflate, 0 = store.
    expect(compressible.readUInt16LE(8)).toBe(8);

    const tiny = createZip([{ name: "a", data: Buffer.from("x") }]);
    expect(tiny.readUInt16LE(8)).toBe(0);
  });

  /**
   * The real check: something that is not our own code has to be able to read it. Python's
   * zipfile module is strict about the format; `python3` is tried when `python` is absent.
   */
  it("is readable by an independent zip implementation, Arabic filenames included", () => {
    const dir = mkdtempSync(join(tmpdir(), "nashir-zip-"));
    const path = join(dir, "test.zip");
    try {
      writeFileSync(path, createZip(entries));
      const script = [
        "import zipfile,sys,json",
        "z=zipfile.ZipFile(sys.argv[1])",
        "assert z.testzip() is None",
        "print(json.dumps({n: z.read(n).decode('utf-8') for n in z.namelist()}))",
      ].join("\n");
      const out = execFileSync(pythonCommand(), ["-c", script, path], { encoding: "utf8" });
      const contents = JSON.parse(out) as Record<string, string>;

      expect(Object.keys(contents).sort()).toEqual(entries.map((e) => e.name).sort());
      expect(contents["manifest.json"]).toContain("Nashir");
      expect(contents["_locales/ar/messages.json"]).toContain("ناشر");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `nashir-files.json` is the list the updater checks an archive against, and it compares
 * with plain `.sort()` order, so the packer has to write exactly that order.
 */
describe("isInstallablePath", () => {
  // Mirrors `isSafeReleasePath` in src/update/applyUpdate.ts, which the updater applies to
  // every entry. Catching a bad name here keeps it from surfacing as a refused update.
  it("accepts what a build produces", () => {
    for (const path of ["manifest.json", "assets/index.ts-C0B9g3py.js", "src/dashboard/index.html", "_locales/ar/messages.json"]) {
      expect(isInstallablePath(path), path).toBe(true);
    }
  });

  it("rejects names Windows would rewrite or reserve, and odd characters", () => {
    for (const path of ["", "a//b.js", "../a.js", "a/./b.js", "a b.js", "dir./a.js", "CON.js", "a/nul", "lpt1.txt", "ä.js", "a\\b.js","C:/x.js"]) {
      expect(isInstallablePath(path), path).toBe(false);
    }
  });
});

describe("isInstallablePath against the updater's rule", () => {
  // The two are written separately (the packer runs without a TypeScript build), so this is
  // what keeps them the same rule: every string up to three tokens from the awkward ones.
  const tokens = ["a", "A", ".", "..", "/", "\\", ":", " ", "-", "_", "con", "x.", "é"];
  const corpus = ["", ...tokens];
  for (const first of tokens) {
    for (const second of tokens) {
      corpus.push(first + second);
      for (const third of tokens) corpus.push(first + second + third);
    }
  }

  it("agrees on every string in the corpus", () => {
    expect(corpus.length).toBe(1 + 13 + 169 + 2197);
    const disagreements = corpus.filter((path) => isInstallablePath(path) !== isSafeReleasePath(path));
    expect(disagreements).toEqual([]);
  });

  it("includes both outcomes, so agreeing is not trivial", () => {
    expect(corpus.some((path) => isSafeReleasePath(path))).toBe(true);
    expect(corpus.some((path) => !isSafeReleasePath(path))).toBe(true);
  });
});

describe("releasePathProblems", () => {
  // The same two checks `unpackRelease` makes on the way in, so a bad tree fails at packaging.
  it("accepts a tree of distinct files", () => {
    expect(releasePathProblems(["manifest.json", "assets/a.js", "assets/b.js", "assets-x/a.js"])).toEqual([]);
  });

  it("flags two paths that differ only by case", () => {
    const problems = releasePathProblems(["assets/Index.js", "assets/index.js"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Index\.js/);
  });

  it("flags a file that is also the folder of another, in any case", () => {
    expect(releasePathProblems(["assets", "assets/a.js"])).toHaveLength(1);
    expect(releasePathProblems(["Assets", "assets/deep/a.js"])).toHaveLength(1);
  });
});

describe("packRelease", () => {
  let root: string;
  let dist: string;
  let out: string;

  function put(name: string, data: string) {
    const path = join(dist, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nashir-pack-"));
    dist = join(root, "dist");
    out = join(root, "release");
    // Names chosen so UTF-16 code-unit order differs from locale order: upper case before
    // lower case, and "_" between them.
    put("manifest.json", '{"name":"Nashir","version":"1.2.3"}');
    put("assets/b.js", "b");
    put("assets/c.js", "c");
    put("Zeta.js", "z");
    put("alpha.js", "a");
    put("_locales/ar/messages.json", "{}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const readZip = (path: string) => unzipSync(new Uint8Array(readFileSync(path)));

  it("writes nashir-files.json listing every file, sorted", async () => {
    const { zipPath } = await packRelease({ dist, out });
    expect(zipPath).toBe(join(out, "nashir-1.2.3.zip"));

    const entries = readZip(zipPath);
    const list = JSON.parse(new TextDecoder().decode(entries["nashir-files.json"]));
    expect(list).toEqual([
      "Zeta.js",
      "_locales/ar/messages.json",
      "alpha.js",
      "assets/b.js",
      "assets/c.js",
      "manifest.json",
      "nashir-files.json",
    ]);
    expect(list).toEqual([...list].sort());
    expect(Object.keys(entries).sort()).toEqual(list);
  });

  it("is byte-identical when run twice on the same input", async () => {
    const first = readFileSync((await packRelease({ dist, out })).zipPath);
    const second = readFileSync((await packRelease({ dist, out })).zipPath);
    expect(first.equals(second)).toBe(true);
  });

  it.each(["assets/has space.js", "assets/ünï.js"])(
    "refuses %s, which the updater would later refuse to install",
    async (name) => {
      put(name, "x");
      await expect(packRelease({ dist, out })).rejects.toThrow(name);
    },
  );

  it.each([
    ["a facebook.com pattern", ["*://*.facebook.com/*"]],
    ["a pattern that includes it among others", ["https://example.org/*", "*://upload.facebook.com/*"]],
    ["every site", ["<all_urls>"]],
    ["every site, spelled as a pattern", ["*://*/*"]],
  ])("refuses a web-accessible entry that reaches facebook.com (%s)", async (_label, matches) => {
    put(
      "manifest.json",
      JSON.stringify({
        version: "1.2.3",
        web_accessible_resources: [{ matches, resources: ["a.js"], use_dynamic_url: true }],
      }),
    );
    await expect(packRelease({ dist, out })).rejects.toThrow(/facebook\.com/);
  });

  it("accepts a manifest with no web-accessible resources", async () => {
    await expect(packRelease({ dist, out })).resolves.toBeTruthy();
  });

  it("accepts a web-accessible entry that no facebook.com page can request", async () => {
    put(
      "manifest.json",
      JSON.stringify({
        version: "1.2.3",
        web_accessible_resources: [{ matches: ["https://example.org/*"], resources: ["a.js"] }],
      }),
    );
    await expect(packRelease({ dist, out })).resolves.toBeTruthy();
  });

  it("refuses a dist that already has its own nashir-files.json", async () => {
    put("nashir-files.json", "[]");
    await expect(packRelease({ dist, out })).rejects.toThrow(/nashir-files\.json/);
  });

  it("runs from the command line against --dist and --out", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "pack.mjs");
    const output = execFileSync(process.execPath, [script, "--dist", dist, "--out", out], { encoding: "utf8" });
    expect(output).toContain("nashir-1.2.3.zip");
    expect(Object.keys(readZip(join(out, "nashir-1.2.3.zip")))).toContain("nashir-files.json");
  });
});
