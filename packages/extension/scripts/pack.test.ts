import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs build scripts, no declarations
import { createZip, crc32 } from "./lib/zip.mjs";

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
