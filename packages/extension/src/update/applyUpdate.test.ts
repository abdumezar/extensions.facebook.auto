import { describe, it, expect, vi } from "vitest";
import { applyUpdate, isSafeReleasePath, UpdateWriteError } from "./applyUpdate.js";
import { MemoryDirectory } from "./MemoryDirectory.js";

const enc = (text: string) => new TextEncoder().encode(text);
const release = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc(text)]));

describe.each([
  ["case-sensitive folder", false],
  ["case-insensitive folder", true],
])("applyUpdate on a %s", (_label, caseInsensitive) => {
  const makeDir = (initial: Record<string, string> = {}) => new MemoryDirectory(initial, { caseInsensitive });

  it("writes new paths before overwriting existing ones", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old-a", "b.js": "old-b" });
    const files = release({ "manifest.json": "new", "a.js": "new-a", "new.js": "new-new", "b.js": "new-b" });

    const result = await applyUpdate(dir, files, null);

    expect(dir.writes[0]).toBe("new.js");
    expect(dir.writes.slice(1, 3).sort()).toEqual(["a.js", "b.js"]);
    expect(result.written).toBe(4);
    expect(dir.snapshot()).toEqual({ "manifest.json": "new", "a.js": "new-a", "b.js": "new-b", "new.js": "new-new" });
  });

  it("manifest.json is the last write", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old-a" });
    await applyUpdate(dir, release({ "manifest.json": "new", "a.js": "new-a", "z.js": "z" }), null);
    expect(dir.writes.at(-1)).toBe("manifest.json");
    expect(dir.writes.filter((p) => p === "manifest.json")).toHaveLength(1);
  });

  it("manifest.json is still last when it did not exist before", async () => {
    const dir = makeDir();
    await applyUpdate(dir, release({ "manifest.json": "m", "a.js": "a", "sub/b.js": "b" }), null);
    expect(dir.writes.at(-1)).toBe("manifest.json");
  });

  it("deletes only files the previous release owned", async () => {
    const dir = makeDir({
      "manifest.json": "old",
      "kept.js": "k",
      "gone.js": "g",
      "notes.txt": "mine",
    });
    const result = await applyUpdate(dir, release({ "manifest.json": "new", "kept.js": "k2" }), [
      "gone.js",
      "kept.js",
      "manifest.json",
    ]);
    expect(result.removed).toBe(1);
    expect(dir.snapshot()).toEqual({ "manifest.json": "new", "kept.js": "k2", "notes.txt": "mine" });
  });

  it("deletes nothing when there is no previous file list", async () => {
    const dir = makeDir({ "manifest.json": "old", "stale.js": "s" });
    const result = await applyUpdate(dir, release({ "manifest.json": "new" }), null);
    expect(result.removed).toBe(0);
    expect(dir.deletes).toEqual([]);
    expect(await dir.exists("stale.js")).toBe(true);
  });

  it("case-only rename keeps the new file", async () => {
    const dir = makeDir({ "manifest.json": "old", "Foo.js": "old" });
    const result = await applyUpdate(dir, release({ "manifest.json": "new", "foo.js": "new" }), [
      "manifest.json",
      "Foo.js",
    ]);
    expect(result.removed).toBe(0);
    expect(dir.deletes).toEqual([]);
    expect(await dir.exists("foo.js")).toBe(true);
    expect(new TextDecoder().decode((await dir.readFile("foo.js"))!)).toBe("new");
  });

  it("ignores unsafe paths in the previous file list", async () => {
    const dir = makeDir({ "manifest.json": "old", "gone.js": "g", "../outside.js": "x", "a\\b.js": "y" });
    const result = await applyUpdate(dir, release({ "manifest.json": "new" }), [
      "../outside.js",
      "/abs.js",
      "a\\b.js",
      "C:/x.js",
      "a//b.js",
      "./a.js",
      "a./b.js",
      "gone.js",
    ]);
    expect(dir.deletes).toEqual(["gone.js"]);
    expect(result.removed).toBe(1);
  });

  it("restores originals and removes created files when a write fails", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old-a", "b.js": "old-b" });
    const before = dir.snapshot();
    dir.failOnWrite(3);

    const error = await applyUpdate(
      dir,
      release({ "manifest.json": "new", "a.js": "new-a", "b.js": "new-b", "n1.js": "1", "n2.js": "2" }),
      ["manifest.json", "a.js", "b.js", "old-only.js"],
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpdateWriteError);
    expect((error as UpdateWriteError).restored).toBe(true);
    expect(dir.snapshot()).toEqual(before);
  });

  it("never deletes before all writes succeed", async () => {
    const dir = makeDir({ "manifest.json": "old", "stale.js": "s" });
    // the manifest is written last, so failing the last write fails after everything else
    dir.failOnWrite(3);
    await expect(
      applyUpdate(dir, release({ "manifest.json": "new", "a.js": "a", "b.js": "b" }), ["stale.js", "manifest.json"]),
    ).rejects.toBeInstanceOf(UpdateWriteError);
    expect(dir.deletes).not.toContain("stale.js");
    expect(await dir.exists("stale.js")).toBe(true);
  });

  it("reports restored: false when the rollback itself fails", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old-a" });
    const realWrite = dir.writeFile.bind(dir);
    let calls = 0;
    dir.writeFile = async (path, data) => {
      calls += 1;
      // first write succeeds, then the next write and the restore of a.js both fail
      if (calls >= 2) throw new Error("disk gone");
      return realWrite(path, data);
    };
    const error = await applyUpdate(dir, release({ "manifest.json": "new", "a.js": "new-a", "n.js": "n" }), null).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpdateWriteError);
    expect((error as UpdateWriteError).restored).toBe(false);
  });

  it("logs deletion failures instead of throwing", async () => {
    const dir = makeDir({ "manifest.json": "old", "gone.js": "g", "gone2.js": "g2" });
    const realDelete = dir.deleteFile.bind(dir);
    dir.deleteFile = async (path) => {
      if (path === "gone.js") throw new Error("locked");
      return realDelete(path);
    };
    const log = vi.fn();

    const result = await applyUpdate(dir, release({ "manifest.json": "new" }), ["gone.js", "gone2.js"], log);

    expect(result.removed).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("gone.js");
    expect(await dir.exists("gone2.js")).toBe(false);
  });
  it("every delete follows the last write on the success path", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old", "gone.js": "g", "gone2.js": "g" });
    await applyUpdate(dir, release({ "manifest.json": "new", "a.js": "new", "b.js": "b" }), [
      "manifest.json",
      "a.js",
      "gone.js",
      "gone2.js",
    ]);
    const lastWrite = dir.ops.map((op) => op.startsWith("write:")).lastIndexOf(true);
    const firstDelete = dir.ops.findIndex((op) => op.startsWith("delete:"));
    expect(firstDelete).toBeGreaterThan(lastWrite);
    expect(dir.ops.filter((op) => op.startsWith("delete:"))).toHaveLength(2);
  });

  it("writes nashir-files.json immediately before manifest.json", async () => {
    const dir = makeDir({ "manifest.json": "old", "nashir-files.json": "[]", "a.js": "old" });
    await applyUpdate(
      dir,
      release({ "manifest.json": "m", "nashir-files.json": "[1]", "a.js": "new", "b.js": "b" }),
      null,
    );
    expect(dir.writes.slice(-2)).toEqual(["nashir-files.json", "manifest.json"]);
  });

  it("refuses a release without manifest.json before writing anything", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old" });
    const before = dir.snapshot();

    const error = await applyUpdate(dir, release({ "a.js": "new" }), ["manifest.json", "a.js"]).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UpdateWriteError);
    expect((error as UpdateWriteError).restored).toBe(true);
    expect(dir.ops).toEqual([]);
    expect(dir.snapshot()).toEqual(before);
  });

  it("refuses paths that differ only by case before writing anything", async () => {
    const dir = makeDir({ "manifest.json": "old" });
    await expect(
      applyUpdate(dir, release({ "manifest.json": "new", "A.js": "1", "a.js": "2" }), null),
    ).rejects.toBeInstanceOf(UpdateWriteError);
    expect(dir.ops).toEqual([]);
  });

  it.each([["../evil.js"], ["CON"], ["a\b.js"], ["/abs.js"]])(
    "refuses a release containing the unsafe path %j before writing anything",
    async (unsafe) => {
      const dir = makeDir({ "manifest.json": "old", "a.js": "old" });
      const before = dir.snapshot();

      const error = await applyUpdate(
        dir,
        release({ "manifest.json": "new", "a.js": "new", [unsafe]: "x" }),
        ["manifest.json", "a.js"],
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpdateWriteError);
      expect((error as UpdateWriteError).restored).toBe(true);
      expect(dir.ops).toEqual([]);
      expect(dir.snapshot()).toEqual(before);
    },
  );

  it("treats the manifest name case-insensitively, still writing it last", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old" });
    await applyUpdate(dir, release({ "Manifest.JSON": "new", "a.js": "new", "n.js": "n" }), null);
    expect(dir.writes.at(-1)).toBe("Manifest.JSON");
    expect(dir.writes.filter((p) => p.toLowerCase() === "manifest.json")).toHaveLength(1);
  });

  it("aborts before writing a path it cannot read back, and restores", async () => {
    const dir = makeDir({ "manifest.json": "old", "a.js": "old-a", "b.js": "old-b" });
    const before = dir.snapshot();
    const realRead = dir.readFile.bind(dir);
    // exists() says yes, but the original cannot be read: it could not be restored later
    dir.readFile = async (path) => (path === "b.js" ? null : realRead(path));

    const error = await applyUpdate(
      dir,
      release({ "manifest.json": "new", "a.js": "new-a", "b.js": "new-b", "n.js": "n" }),
      null,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpdateWriteError);
    expect((error as UpdateWriteError).restored).toBe(true);
    expect(dir.writes).not.toContain("b.js");
    expect(dir.snapshot()).toEqual(before);
  });

  it("reports a failing exists() as an update error with nothing written", async () => {
    const dir = makeDir({ "manifest.json": "old" });
    dir.exists = async () => {
      throw new Error("permission revoked");
    };
    const error = await applyUpdate(dir, release({ "manifest.json": "new", "a.js": "a" }), null).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpdateWriteError);
    expect((error as UpdateWriteError).restored).toBe(true);
    expect(dir.writes).toEqual([]);
  });

  it("survives a malformed previous file list after the writes landed", async () => {
    const dir = makeDir({ "manifest.json": "old", "gone.js": "g" });
    const result = await applyUpdate(
      dir,
      release({ "manifest.json": "new" }),
      [null, 42, "gone.js"] as unknown as string[],
    );
    expect(result.removed).toBe(1);
    expect(await dir.exists("gone.js")).toBe(false);
  });

  it.each([["manifest.json"], [{ length: 1 }], [42], [{}]])("ignores a previous file list of %j", async (bad) => {
    const dir = makeDir({ "manifest.json": "old", "gone.js": "g" });
    const result = await applyUpdate(dir, release({ "manifest.json": "new" }), bad as unknown as string[]);
    expect(result).toEqual({ written: 1, removed: 0 });
    expect(await dir.exists("gone.js")).toBe(true);
  });
});

describe("isSafeReleasePath", () => {
  it.each(["manifest.json", "assets/app.js", "a/b/c.png", "a.b", "assets/index-AbC_12.js", "_locales/en/messages.json", "console.js"])(
    "accepts %s",
    (p) => {
      expect(isSafeReleasePath(p)).toBe(true);
    },
  );
  it.each([
    "",
    "/abs.js",
    "../evil.js",
    "a/../b.js",
    "a\b.js",
    "C:/x.js",
    "a//b.js",
    "./a.js",
    "a/./b.js",
    "a./b.js",
    "a /b.js",
    "a/b.",
    "a/b ",
    "a/",
    " a.js",
    "a b",
    "a*b?.js",
    "a<b>.js",
    "a	b",
    "a|b.js",
    'a"b.js',
    "CON",
    "nul.js",
    "aux/x.js",
    "COM1.txt",
    "x/lpt9.tar.gz",
    "Prn",
  ])("rejects %j", (p) => {
    expect(isSafeReleasePath(p)).toBe(false);
  });
});
