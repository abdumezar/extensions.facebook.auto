import { describe, expect, it } from "vitest";
import {
  fbErrorHaystack,
  fbErrorText,
  fbErrorsOf,
  parseFbJson,
  stripFbPrefix,
} from "./fbResponse.js";

describe("stripFbPrefix", () => {
  it("removes the anti-hijacking guard in every spacing Facebook uses", () => {
    expect(stripFbPrefix('for (;;);{"a":1}')).toBe('{"a":1}');
    expect(stripFbPrefix('for(;;);{"a":1}')).toBe('{"a":1}');
    expect(stripFbPrefix('for  (;;);  {"a":1}  ')).toBe('{"a":1}');
  });

  it("leaves a body that never had one alone", () => {
    expect(stripFbPrefix('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseFbJson", () => {
  it("takes the first object of a newline-streamed relay response", () => {
    const body = 'for (;;);{"data":{"ok":true}}\n{"extensions":{"is_final":true}}';
    expect(parseFbJson(body)).toEqual({ data: { ok: true } });
  });

  it("returns null rather than throwing on garbage", () => {
    expect(parseFbJson("<!DOCTYPE html><html>login</html>")).toBeNull();
    expect(parseFbJson("")).toBeNull();
  });
});

describe("fbErrorsOf", () => {
  it("reads the GraphQL errors array, codes included", () => {
    const json = parseFbJson(
      'for (;;);{"errors":[{"message":"Too many requests","code":4,"error_subcode":1349001,"severity":"CRITICAL","is_transient":false}]}',
    );
    expect(fbErrorsOf(json)).toEqual([
      {
        message: "Too many requests",
        summary: undefined,
        description: undefined,
        code: 4,
        subcode: 1349001,
        isTransient: false,
        allowUserRetry: undefined,
        severity: "CRITICAL",
      },
    ]);
  });

  it("reads api_error_code when code is absent", () => {
    expect(fbErrorsOf({ errors: [{ api_error_code: 613 }] })[0]?.code).toBe(613);
  });

  it("reads the Graph API nested error object", () => {
    const errs = fbErrorsOf({ error: { message: "limit", code: 17, error_subcode: 2446079 } });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe(17);
    expect(errs[0]?.subcode).toBe(2446079);
  });

  it("reads the internal-www shape where `error` IS the code", () => {
    const json = parseFbJson(
      'for (;;);{"__ar":1,"error":1357004,"errorSummary":"Too many API requests","errorDescription":"There have been too many calls from this app. Wait a bit and try again.","payload":null}',
    );
    const errs = fbErrorsOf(json);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe(1357004);
    expect(errs[0]?.summary).toBe("Too many API requests");
    expect(errs[0]?.description).toContain("too many calls from this app");
  });

  it("accepts a quoted numeric code", () => {
    expect(fbErrorsOf({ error: { code: "368" } })[0]?.code).toBe(368);
  });

  it("finds nothing in a clean response", () => {
    expect(fbErrorsOf({ data: { story: { id: "1" } } })).toEqual([]);
    expect(fbErrorsOf({ error: 0 })).toEqual([]);
    expect(fbErrorsOf(null)).toEqual([]);
  });
});

describe("fbErrorText", () => {
  it("joins the readable parts and falls back to the code", () => {
    expect(fbErrorText([{ message: "a" }, { summary: "b" }, { code: 4 }])).toBe("a; b; #4");
  });

  it("is undefined when there is nothing to say", () => {
    expect(fbErrorText([])).toBeUndefined();
  });
});

describe("fbErrorHaystack", () => {
  it("includes the description the old parser dropped", () => {
    const json = parseFbJson(
      'for (;;);{"error":1357004,"errorSummary":"Too many API requests","errorDescription":"There have been too many calls from this app."}',
    );
    expect(fbErrorHaystack(fbErrorsOf(json))).toContain("too many calls from this app");
  });
});
