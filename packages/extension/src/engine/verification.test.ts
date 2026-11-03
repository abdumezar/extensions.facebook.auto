import { describe, expect, it } from "vitest";
import type { StoragePort } from "./ports/index.js";
import {
  VERIFIED_KEY,
  markVerified,
  readVerifiedAt,
  sha256Hex,
  type VerifiedMap,
} from "./verification.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;

/** A stand-in hash that is readable in assertions: it never sees a raw value leave. */
const fakeHash = async (v: string) => `h(${v})`;

function memory(): { storage: StoragePort; map: Map<string, unknown>; writes: () => number } {
  const map = new Map<string, unknown>();
  let writes = 0;
  const storage: StoragePort = {
    async get<T>(k: string) {
      return (map.get(k) as T) ?? null;
    },
    async set(k, v) {
      writes++;
      map.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k) {
      map.delete(k);
    },
  };
  return { storage, map, writes: () => writes };
}

describe("markVerified", () => {
  it("stores the time and a hash of xs, keyed by the user id", async () => {
    const { storage, map } = memory();
    await markVerified(storage, fakeHash, "u1", "secret-xs", T0);
    expect(map.get(VERIFIED_KEY)).toEqual({ u1: { at: T0, xs: "h(secret-xs)" } });
  });

  it("never stores the raw xs value", async () => {
    const { storage, map } = memory();
    await markVerified(storage, sha256Hex, "u1", "secret-xs", T0);
    const raw = JSON.stringify(map.get(VERIFIED_KEY));
    expect(raw).not.toContain("secret-xs");
    expect(raw).toMatch(/[0-9a-f]{64}/);
  });

  it("writes once for repeated marks inside five minutes", async () => {
    const { storage, writes } = memory();
    await markVerified(storage, fakeHash, "u1", "xs", T0);
    await markVerified(storage, fakeHash, "u1", "xs", T0 + 1 * MIN);
    await markVerified(storage, fakeHash, "u1", "xs", T0 + 4 * MIN);
    expect(writes()).toBe(1);
  });

  it("writes again after five minutes", async () => {
    const { storage, map } = memory();
    await markVerified(storage, fakeHash, "u1", "xs", T0);
    await markVerified(storage, fakeHash, "u1", "xs", T0 + 5 * MIN);
    expect((map.get(VERIFIED_KEY) as VerifiedMap).u1?.at).toBe(T0 + 5 * MIN);
  });

  it("writes straight away when xs changed", async () => {
    const { storage, map } = memory();
    await markVerified(storage, fakeHash, "u1", "xs-old", T0);
    await markVerified(storage, fakeHash, "u1", "xs-new", T0 + MIN);
    expect(map.get(VERIFIED_KEY)).toEqual({ u1: { at: T0 + MIN, xs: "h(xs-new)" } });
  });

  it("keeps other users' entries untouched", async () => {
    const { storage, map } = memory();
    await markVerified(storage, fakeHash, "current", "xs-a", T0);
    await markVerified(storage, fakeHash, "managed", "xs-b", T0 + MIN);
    expect(map.get(VERIFIED_KEY)).toEqual({
      current: { at: T0, xs: "h(xs-a)" },
      managed: { at: T0 + MIN, xs: "h(xs-b)" },
    });
  });

  it("keeps only the five most recent entries", async () => {
    const { storage, map } = memory();
    for (let i = 0; i < 7; i++) {
      await markVerified(storage, fakeHash, `u${i}`, "xs", T0 + i * MIN);
    }
    expect(Object.keys(map.get(VERIFIED_KEY) as VerifiedMap).sort()).toEqual([
      "u2",
      "u3",
      "u4",
      "u5",
      "u6",
    ]);
  });

  it("does not lose entries when marks overlap", async () => {
    const { storage, map } = memory();
    await Promise.all([
      markVerified(storage, fakeHash, "a", "xs", T0),
      markVerified(storage, fakeHash, "b", "xs", T0),
    ]);
    expect(Object.keys(map.get(VERIFIED_KEY) as VerifiedMap).sort()).toEqual(["a", "b"]);
  });
});

describe("readVerifiedAt", () => {
  async function seeded(at = T0) {
    const m = memory();
    await markVerified(m.storage, fakeHash, "u1", "xs", at);
    return m.storage;
  }

  it("returns the time for a fresh entry with a matching xs", async () => {
    const storage = await seeded();
    expect(await readVerifiedAt(storage, fakeHash, "u1", "xs", T0 + HOUR)).toBe(T0);
  });

  it("returns nothing once the entry is twelve hours old", async () => {
    const storage = await seeded();
    expect(await readVerifiedAt(storage, fakeHash, "u1", "xs", T0 + 12 * HOUR)).toBeUndefined();
  });

  it("returns nothing when xs changed", async () => {
    const storage = await seeded();
    expect(await readVerifiedAt(storage, fakeHash, "u1", "other", T0 + MIN)).toBeUndefined();
  });

  it("returns nothing for a different user", async () => {
    const storage = await seeded();
    expect(await readVerifiedAt(storage, fakeHash, "u2", "xs", T0 + MIN)).toBeUndefined();
  });

  it("returns nothing for an entry from the future", async () => {
    const storage = await seeded(T0 + HOUR);
    expect(await readVerifiedAt(storage, fakeHash, "u1", "xs", T0)).toBeUndefined();
  });

  it("returns nothing when storage holds something unexpected", async () => {
    const { storage, map } = memory();
    map.set(VERIFIED_KEY, "garbage");
    expect(await readVerifiedAt(storage, fakeHash, "u1", "xs", T0)).toBeUndefined();
  });
});

describe("sha256Hex", () => {
  it("is the lowercase hex SHA-256 digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
