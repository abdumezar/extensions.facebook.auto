import { DEFAULT_FB_RECIPE } from "@nashir/shared";
import { describe, expect, it } from "vitest";
import { detectThrottle } from "./governorMath.js";

/**
 * The exact copy Facebook served on 2026-08-27, verbatim.
 *
 * Recorded as a test rather than only added to a signal list because the whole point of
 * the checkpoint path is that it is NOT a wait — misclassifying this as a rate limit
 * would arm a timer, let the timer expire, and walk straight back into a blocked
 * account. Facebook's guidance is that calls made during a block extend it.
 */
const COPY = "Facebook needs you to confirm it is you before this can continue.";

describe("the checkpoint Facebook actually served", () => {
  const verdict = detectThrottle({ status: 200, bodyText: COPY, recipe: DEFAULT_FB_RECIPE });

  it("is classified as a checkpoint, not a rate limit", () => {
    expect(verdict.class).toBe("checkpoint");
  });

  it("is scoped to the account, not globally", () => {
    expect(verdict.scope).toBe("account");
  });

  it("carries no server-stated retry — nothing but a person clears it", () => {
    expect(verdict.retryAfterMs).toBeUndefined();
  });

  it("keeps Facebook's own words for the operator to read", () => {
    expect(verdict.evidence).toContain("confirm it is you");
  });

  it("is still recognised inside a full JSON error body", () => {
    const body = JSON.stringify({ errors: [{ message: COPY, code: 601 }] });
    expect(detectThrottle({ status: 200, bodyText: body, recipe: DEFAULT_FB_RECIPE }).class).toBe(
      "checkpoint",
    );
  });

  it("is recognised from the numeric code alone", () => {
    const body = JSON.stringify({ error: { code: 601, message: "unrecognised wording" } });
    expect(detectThrottle({ status: 200, bodyText: body, recipe: DEFAULT_FB_RECIPE }).class).toBe(
      "checkpoint",
    );
  });
});
