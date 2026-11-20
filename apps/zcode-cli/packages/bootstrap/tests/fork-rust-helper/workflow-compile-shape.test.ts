import { describe, expect, it } from "vitest";
import { jsonShape } from "../../src/fork-rust-helper/workflow-compile.js";

// specs/fork-rust-workflow-engine.md, 9.37 (W7-7b review): the compile reply's JSON copy.

describe("fork: the compile reply's JSON shape (9.37, review)", () => {
  it("leaves a Date to JSON.stringify: its toJSON text, not an empty object", () => {
    const at = new Date(0);
    expect(JSON.stringify(jsonShape({ at }))).toBe(JSON.stringify({ at }));
  });

  it("refuses two Map keys that stringify to the same text, instead of overwriting one", () => {
    expect(() => jsonShape(new Map<unknown, unknown>([[1, "a"], ["1", "b"]]))).toThrow(/same key/);
  });
});
