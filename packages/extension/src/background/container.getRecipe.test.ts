import { DEFAULT_FB_RECIPE, bundledDocIds } from "@nashir/shared";
import { describe, expect, it, vi } from "vitest";
import { Container } from "./container.js";

const REACTIONS_FIRST = "CometUFIReactionsDialogQuery";

// getRecipe only touches docIds and logger; calling it on a bare object avoids
// constructing the whole container, which needs chrome.
const getRecipe = (self: unknown) => Container.prototype.getRecipe.call(self);

describe("Container.getRecipe", () => {
  it("applies learned doc_ids to the bundled recipe", async () => {
    const bundled = bundledDocIds(DEFAULT_FB_RECIPE)[REACTIONS_FIRST]!;
    const recipe = await getRecipe({
      docIds: {
        get: async () => ({ [REACTIONS_FIRST]: { docId: "70000020", seenAt: 1, bundledAtLearn: bundled } }),
      },
      logger: { warn: vi.fn() },
    });
    expect(recipe.postAudience?.reactionsFirst?.docId).toBe("70000020");
  });

  it("falls back to the bundled recipe when the override store throws", async () => {
    const warn = vi.fn();
    const recipe = await getRecipe({
      docIds: {
        get: async () => {
          throw new Error("storage unavailable");
        },
      },
      logger: { warn },
    });
    expect(recipe).toEqual(DEFAULT_FB_RECIPE);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
