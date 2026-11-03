import { describe, expect, it } from "vitest";
import { DEFAULT_FB_RECIPE, type FbRecipe } from "./fbRecipe.js";
import {
  applyDocIdOverrides,
  bundledDocIds,
  recipeFriendlyNames,
  sanitizeHarvest,
  type DocIdOverrides,
} from "./docIdOverrides.js";

const REACTIONS = "CometUFIReactionsDialogTabContentRefetchQuery";
const REACTIONS_FIRST = "CometUFIReactionsDialogQuery";

/** Not a real FbRecipe: shapes the real one does not have today (arrays, deep nesting). */
const synthetic = () =>
  ({
    top: { docId: "10001", friendlyName: "Top", extra: { keep: ["x"] } },
    list: [
      { docId: "10002", friendlyName: "ListA" },
      { docId: "10003", friendlyName: "ListB" },
    ],
    a: { b: { c: { docId: "10004", friendlyName: "Deep" } } },
  }) as unknown as FbRecipe;

const override = (docId: string, bundledAtLearn: string) => ({
  docId,
  seenAt: 1_700_000_000_000,
  bundledAtLearn,
});

describe("recipeFriendlyNames", () => {
  it("lists every friendlyName in DEFAULT_FB_RECIPE", () => {
    const names = recipeFriendlyNames(DEFAULT_FB_RECIPE);
    expect(names).toContain("ComposerStoryCreateMutation");
    expect(names).toContain(REACTIONS);
    expect(names).toContain("CommentsListComponentsPaginationQuery");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(9);
  });

  it("walks arrays and deeply nested optional nodes", () => {
    const recipe = synthetic();
    expect(recipeFriendlyNames(recipe).sort()).toEqual(["Deep", "ListA", "ListB", "Top"]);
    expect(bundledDocIds(recipe)).toEqual({
      Top: "10001",
      ListA: "10002",
      ListB: "10003",
      Deep: "10004",
    });
  });
});

describe("applyDocIdOverrides", () => {
  it("replaces docId by friendlyName on the hot path", () => {
    const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
    const overrides: DocIdOverrides = {
      [REACTIONS]: override("11111111111111111", bundled[REACTIONS]!),
    };
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, overrides);
    expect(next.postAudience!.reactions.docId).toBe("11111111111111111");
    expect(next.postAudience!.reactions.friendlyName).toBe(REACTIONS);
  });

  it("replaces the reactionsFirst node too", () => {
    const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [REACTIONS_FIRST]: override("28949165141359436", bundled[REACTIONS_FIRST]!),
    });
    expect(next.postAudience!.reactionsFirst?.docId).toBe("28949165141359436");
  });

  it("ignores an override learned against a different bundled id", () => {
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [REACTIONS]: override("11111111111111111", "99999999999999999"),
    });
    expect(next.postAudience!.reactions.docId).toBe(
      DEFAULT_FB_RECIPE.postAudience!.reactions.docId,
    );
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(DEFAULT_FB_RECIPE);
    const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [REACTIONS]: override("11111111111111111", bundled[REACTIONS]!),
    });
    expect(next).not.toBe(DEFAULT_FB_RECIPE);
    expect(JSON.stringify(DEFAULT_FB_RECIPE)).toBe(before);
  });
});

describe("applyDocIdOverrides isolation and validation", () => {
  const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
  const composer = "ComposerStoryCreateMutation";
  const leave = "useGroupLeaveMutation";

  it("shares no mutable state with the input recipe", () => {
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [composer]: override("11111111111111111", bundled[composer]!),
    });
    expect(next.createGroupPost.docId).toBe("11111111111111111");
    expect(next.createGroupPost.staticInput).not.toBe(DEFAULT_FB_RECIPE.createGroupPost.staticInput);
    expect(next.createGroupPost.topLevel).not.toBe(DEFAULT_FB_RECIPE.createGroupPost.topLevel);
    const before = JSON.stringify(DEFAULT_FB_RECIPE);
    next.createGroupPost.staticInput.injected = "x";
    next.createGroupPost.topLevel.injected = "x";
    expect(JSON.stringify(DEFAULT_FB_RECIPE)).toBe(before);
  });

  it("isolates even when no override applies", () => {
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {});
    expect(next.createGroupPost.staticInput).not.toBe(DEFAULT_FB_RECIPE.createGroupPost.staticInput);
    expect(next).toEqual(DEFAULT_FB_RECIPE);
  });

  it("keeps the extra fields of an overridden node", () => {
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [leave]: override("11111111111111111", bundled[leave]!),
    });
    expect(next.leaveGroup?.docId).toBe("11111111111111111");
    expect(next.leaveGroup).toEqual({
      ...DEFAULT_FB_RECIPE.leaveGroup,
      docId: "11111111111111111",
    });
    expect(next.leaveGroup?.actionSource).toBe(DEFAULT_FB_RECIPE.leaveGroup?.actionSource);
  });

  it("leaves non-overridden nodes deep-equal to the originals", () => {
    const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
      [REACTIONS]: override("11111111111111111", bundled[REACTIONS]!),
    });
    expect({ ...next, postAudience: undefined }).toEqual({
      ...DEFAULT_FB_RECIPE,
      postAudience: undefined,
    });
    expect(next.postAudience!.comments).toEqual(DEFAULT_FB_RECIPE.postAudience!.comments);
  });

  it("applies to arrays and deeply nested nodes", () => {
    const next = applyDocIdOverrides(synthetic(), {
      ListB: override("55555", "10003"),
      Deep: override("66666", "10004"),
    }) as unknown as {
      list: { docId: string }[];
      a: { b: { c: { docId: string } } };
      top: { extra: unknown };
    };
    expect(next.list.map((n) => n.docId)).toEqual(["10002", "55555"]);
    expect(next.a.b.c.docId).toBe("66666");
    expect(next.top.extra).toEqual({ keep: ["x"] });
  });

  it("ignores malformed overrides", () => {
    const bad = [
      { docId: 28949165141359436, seenAt: 1, bundledAtLearn: bundled[REACTIONS] },
      { seenAt: 1, bundledAtLearn: bundled[REACTIONS] },
      { docId: "abc", seenAt: 1, bundledAtLearn: bundled[REACTIONS] },
      { docId: "1234", seenAt: 1, bundledAtLearn: bundled[REACTIONS] },
      { docId: "11111111111111111", seenAt: 1 },
      { docId: "11111111111111111", seenAt: 1, bundledAtLearn: 37480094514909095 },
      null,
      "11111111111111111",
    ];
    for (const entry of bad) {
      const next = applyDocIdOverrides(DEFAULT_FB_RECIPE, {
        [REACTIONS]: entry as unknown as DocIdOverrides[string],
      });
      expect(next.postAudience!.reactions.docId).toBe(bundled[REACTIONS]);
    }
  });
});

describe("sanitizeHarvest", () => {
  const bundled = { A: "10000", B: "20000", C: "30000" };

  it("keeps valid ids for known names", () => {
    expect(sanitizeHarvest({ A: "12345", B: "9876543210" }, bundled)).toEqual({
      A: "12345",
      B: "9876543210",
    });
  });

  it("drops unknown names, non-digit ids, arrays, oversize input, and ids that belong to another operation", () => {
    expect(sanitizeHarvest({ Z: "12345" }, bundled)).toEqual({});
    expect(sanitizeHarvest({ A: "12ab5" }, bundled)).toEqual({});
    expect(sanitizeHarvest({ A: "1234" }, bundled)).toEqual({});
    expect(sanitizeHarvest({ A: "1".repeat(26) }, bundled)).toEqual({});
    expect(sanitizeHarvest({ A: 12345 }, bundled)).toEqual({});
    expect(sanitizeHarvest(["12345"], bundled)).toEqual({});
    expect(sanitizeHarvest(null, bundled)).toEqual({});
    expect(sanitizeHarvest("A", bundled)).toEqual({});
    // A's value is B's bundled id: a mix-up, dropped. Own bundled id is fine.
    expect(sanitizeHarvest({ A: "20000" }, bundled)).toEqual({});
    expect(sanitizeHarvest({ B: "20000" }, bundled)).toEqual({ B: "20000" });
    // Entry count never exceeds the number of bundled operations.
    const big = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`N${i}`, String(100000 + i)]),
    );
    expect(sanitizeHarvest(big, bundled)).toEqual({});
    // Valid entries still capped at the number of bundled operations.
    const two = { A: "10000", B: "20000" };
    const noisy = { ...big, A: "11111", B: "22222" };
    expect(sanitizeHarvest(noisy, two)).toEqual({ A: "11111", B: "22222" });
    expect(Object.keys(sanitizeHarvest(noisy, two)).length).toBeLessThanOrEqual(2);
    // Two operations sharing a bundled id are ambiguous: both dropped.
    expect(sanitizeHarvest({ A: "55555", B: "55555" }, { A: "55555", B: "55555" })).toEqual({});
  });

  it("drops an id that shows up under more than one name in the harvest", () => {
    expect(sanitizeHarvest({ A: "77777", B: "77777", C: "88888" }, bundled)).toEqual({ C: "88888" });
    // Even when one of them is that operation's own bundled id.
    expect(sanitizeHarvest({ A: "20000", B: "20000" }, bundled)).toEqual({});
  });

  it("accepts null-prototype raw and bundled inputs", () => {
    const raw = Object.assign(Object.create(null), { A: "12345", Z: "99999" });
    const known = Object.assign(Object.create(null), bundled);
    expect(sanitizeHarvest(raw, known)).toEqual({ A: "12345" });
  });

  it("ignores inherited and prototype keys", () => {
    const evil = JSON.parse('{"__proto__": "12345", "A": "12345"}');
    const out = sanitizeHarvest(evil, bundled);
    expect(out).toEqual({ A: "12345" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
