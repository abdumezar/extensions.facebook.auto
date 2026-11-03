import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { unpackRelease, UnsafeArchiveError } from "./unpack.js";

const byName = (a: string, b: string) => (a < b ? -1 : 1);

/** A zip whose `nashir-files.json` lists every other entry, unless the test overrides it. */
function build(
  entries: Record<string, string>,
  options: { manifest?: unknown; fileList?: unknown } = {},
) {
  const manifest = "manifest" in options ? options.manifest : { version: "1.2.3" };
  const all: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(entries)) all[name] = strToU8(text);
  if (manifest !== undefined) {
    all["manifest.json"] = strToU8(typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  const names = [...Object.keys(all), "nashir-files.json"].sort(byName);
  all["nashir-files.json"] = strToU8(JSON.stringify(options.fileList ?? names));
  return zipSync(all);
}

/** Replaces every occurrence of an ASCII name in the archive bytes (same length only). */
function renameAll(zip: Uint8Array, from: string, to: string) {
  const out = zip.slice();
  const a = strToU8(from);
  const b = strToU8(to);
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((byte, j) => out[i + j] === byte)) out.set(b, i);
  }
  return out;
}

/** Rewrites the uncompressed size in every central directory header. */
function declareSize(zip: Uint8Array, size: number) {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}

describe("unpackRelease", () => {
  it("unpacks a well-formed archive and returns its manifest", () => {
    const zip = build(
      { "popup/index.html": "<html>", "assets/app.js": "console.log(1)" },
      { manifest: { version: "1.2.3", key: "abc" } },
    );

    const { files, manifest, fileList } = unpackRelease(zip);

    expect(manifest).toEqual({ version: "1.2.3", key: "abc" });
    expect([...files.keys()].sort()).toEqual(["assets/app.js", "manifest.json", "nashir-files.json", "popup/index.html"]);
    expect(new TextDecoder().decode(files.get("assets/app.js"))).toBe("console.log(1)");
    expect(fileList).toEqual(["assets/app.js", "manifest.json", "nashir-files.json", "popup/index.html"]);
  });

  it("leaves key off the manifest when the archive has none", () => {
    expect(unpackRelease(build({ "a.js": "a" })).manifest).toEqual({ version: "1.2.3" });
  });

  it("drops a manifest key that is not a string", () => {
    expect(unpackRelease(build({}, { manifest: { version: "1.0.0", key: 5 } })).manifest).toEqual({ version: "1.0.0" });
  });

  it("skips directory entries", () => {
    const zip = zipSync({
      "assets/": new Uint8Array(),
      "assets/a.js": strToU8("a"),
      "manifest.json": strToU8('{"version":"1.0.0"}'),
      "nashir-files.json": strToU8('["assets/a.js","manifest.json","nashir-files.json"]'),
    });
    expect([...unpackRelease(zip).files.keys()]).not.toContain("assets/");
  });

  it("rejects traversal entries", () => {
    const bad = ["../evil.js", "/abs.js", "a\\b.js", "C:/x.js", "a//b.js", "./a.js", "a./b.js", "a/../b.js", "con.txt", "a /b.js"];
    for (const name of bad) {
      expect(() => unpackRelease(build({ [name]: "x" })), name).toThrow(UnsafeArchiveError);
    }
  });

  it("rejects paths that differ only by case", () => {
    expect(() => unpackRelease(build({ "A.js": "1", "a.js": "2" }))).toThrow(UnsafeArchiveError);
  });

  it("rejects two entries with the same name", () => {
    // The file list matches what a last-wins reader would see, so only the duplicate itself is wrong.
    const zip = build({ "aaaa.js": "one", "bbbb.js": "two" }, { fileList: ["aaaa.js", "manifest.json", "nashir-files.json"] });
    // Rename the second entry in its local and central headers so the archive holds two aaaa.js.
    const bytes = renameAll(zip, "bbbb.js", "aaaa.js");
    expect(() => unpackRelease(bytes)).toThrow(UnsafeArchiveError);
  });

  it("rejects a path that is both a file and a folder", () => {
    expect(() => unpackRelease(build({ lib: "x", "lib/a.js": "y" }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({ Lib: "x", "lib/a.js": "y" }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({ lib: "x", "Lib/a.js": "y" }))).toThrow(UnsafeArchiveError);
  });

  it("rejects an archive with too many entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 4999; i++) many[`f${i}.txt`] = "";
    // 4999 + manifest.json + nashir-files.json = 5001 entries, one over the limit.
    expect(() => unpackRelease(build(many))).toThrow(UnsafeArchiveError);
    delete many["f0.txt"];
    expect(unpackRelease(build(many)).files.size).toBe(5000);
  });

  it("rejects an entry that declares a huge size", () => {
    const zip = build({ "a.js": "a" });
    expect(() => unpackRelease(declareSize(zip, 201 * 1024 * 1024))).toThrow(/too large/);
  });

  it("rejects entries that are each under the limit but too large together", () => {
    // Every entry declares 101 MiB, so no single one is over 200 MiB but the running total is.
    const zip = build({ "a.js": "a" });
    expect(() => unpackRelease(declareSize(zip, 101 * 1024 * 1024))).toThrow(/too large/);
  });

  it("rejects archive without root manifest", () => {
    expect(() => unpackRelease(build({ "a.js": "a" }, { manifest: undefined }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({ "sub/manifest.json": '{"version":"1.0.0"}' }, { manifest: undefined }))).toThrow(UnsafeArchiveError);
  });

  it("rejects archive without nashir-files.json", () => {
    const zip = zipSync({ "manifest.json": strToU8('{"version":"1.0.0"}'), "a.js": strToU8("a") });
    expect(() => unpackRelease(zip)).toThrow(UnsafeArchiveError);
  });

  it("rejects a nashir-files.json that is not at the root", () => {
    const zip = zipSync({
      "manifest.json": strToU8('{"version":"1.0.0"}'),
      "sub/nashir-files.json": strToU8('["manifest.json","sub/nashir-files.json"]'),
    });
    expect(() => unpackRelease(zip)).toThrow(UnsafeArchiveError);
  });

  it("rejects a file list that omits nashir-files.json itself", () => {
    expect(() => unpackRelease(build({ "a.js": "a" }, { fileList: ["a.js", "manifest.json"] }))).toThrow(UnsafeArchiveError);
  });

  it("rejects a file list that disagrees with the entries", () => {
    const ghost = ["a.js", "ghost.js", "manifest.json", "nashir-files.json"];
    expect(() => unpackRelease(build({ "a.js": "a" }, { fileList: ghost }))).toThrow(UnsafeArchiveError);
    const missing = ["a.js", "manifest.json", "nashir-files.json"];
    expect(() => unpackRelease(build({ "a.js": "a", "b.js": "b" }, { fileList: missing }))).toThrow(UnsafeArchiveError);
    const unsorted = ["nashir-files.json", "manifest.json", "a.js"];
    expect(() => unpackRelease(build({ "a.js": "a" }, { fileList: unsorted }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({ "a.js": "a" }, { fileList: { not: "an array" } }))).toThrow(UnsafeArchiveError);
  });

  it("rejects a manifest that is not JSON or has no version", () => {
    expect(() => unpackRelease(build({}, { manifest: "not json" }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({}, { manifest: {} }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({}, { manifest: { version: 3 } }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({}, { manifest: { version: "" } }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({}, { manifest: [] }))).toThrow(UnsafeArchiveError);
    expect(() => unpackRelease(build({}, { manifest: "null" }))).toThrow(UnsafeArchiveError);
  });

  it("rejects bytes that are not a zip", () => {
    expect(() => unpackRelease(new Uint8Array([1, 2, 3]))).toThrow(UnsafeArchiveError);
  });
});
