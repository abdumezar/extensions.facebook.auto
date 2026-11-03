import { afterEach, describe, expect, it } from "vitest";
import { harvestLookup } from "./harvestLookup.js";

const g = globalThis as unknown as { window?: unknown };
const original = g.window;

function withWindow(require: unknown): void {
  g.window = { require };
}

afterEach(() => {
  if (original === undefined) delete g.window;
  else g.window = original;
});

describe("harvestLookup", () => {
  it("reads ids through window.require and skips throws", () => {
    const asked: string[] = [];
    withWindow((name: string) => {
      asked.push(name);
      if (name.startsWith("Boom")) throw new Error("module not defined");
      if (name.startsWith("Gone")) return undefined;
      return name.startsWith("Num") ? 28949165141359 : "9001234";
    });

    const out = harvestLookup(["Alpha", "Boom", "Gone", "Num"]);

    expect(out).toEqual({ Alpha: "9001234", Num: "28949165141359" });
    expect(asked).toEqual([
      "Alpha_facebookRelayOperation",
      "Boom_facebookRelayOperation",
      "Gone_facebookRelayOperation",
      "Num_facebookRelayOperation",
    ]);
  });

  it("drops a numeric id above MAX_SAFE_INTEGER", () => {
    // 28949165141359436 is not representable: the literal is already rounded.
    withWindow(() => 28949165141359436);
    expect(harvestLookup(["Alpha"])).toEqual({});
  });

  it("ignores values that are neither strings nor safe integers", () => {
    const values: Record<string, unknown> = {
      A: { id: "123456" },
      B: 12.5,
      C: null,
      D: true,
      E: Number.NaN,
    };
    withWindow((name: string) => values[name.replace("_facebookRelayOperation", "")]);
    expect(harvestLookup(Object.keys(values))).toEqual({});
  });

  it("returns nothing when window.require is missing", () => {
    g.window = {};
    expect(harvestLookup(["Alpha"])).toEqual({});
  });

  it("runs when rebuilt from its source", () => {
    // executeScript serialises the function with toString(); it must not lean on
    // anything outside its own body.
    withWindow((name: string) => (name === "Alpha_facebookRelayOperation" ? "555123" : undefined));
    const rebuilt = new Function("return (" + harvestLookup.toString() + ")")() as typeof harvestLookup;
    expect(rebuilt(["Alpha", "Beta"])).toEqual({ Alpha: "555123" });
  });

  it("has nothing in its text that would break outside its module", () => {
    const text = harvestLookup.toString();
    expect(text).not.toContain("__name");
    expect(text).not.toMatch(/import/);
    expect(text.replaceAll("window.require(", "")).not.toContain("require(");
  });
});
