import { describe, expect, it } from "vitest";
import { computeQuickPromptScrollFades } from "@/quick-prompts/scrollFades.js";

describe("computeQuickPromptScrollFades", () => {
  it("shows no fade when the row fits", () => {
    expect(
      computeQuickPromptScrollFades({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }),
    ).toEqual({
      left: false,
      right: false,
    });
  });

  it("shows only the right fade at the start of an overflowing row", () => {
    expect(
      computeQuickPromptScrollFades({ scrollLeft: 0, clientWidth: 400, scrollWidth: 800 }),
    ).toEqual({
      left: false,
      right: true,
    });
  });

  it("shows both fades mid-scroll and only the left fade at the end", () => {
    expect(
      computeQuickPromptScrollFades({ scrollLeft: 100, clientWidth: 400, scrollWidth: 800 }),
    ).toEqual({
      left: true,
      right: true,
    });
    expect(
      computeQuickPromptScrollFades({ scrollLeft: 400, clientWidth: 400, scrollWidth: 800 }),
    ).toEqual({
      left: true,
      right: false,
    });
  });

  it("ignores sub-pixel rounding at both edges", () => {
    expect(
      computeQuickPromptScrollFades({ scrollLeft: 0.5, clientWidth: 400, scrollWidth: 400.6 }),
    ).toEqual({
      left: false,
      right: false,
    });
  });
});
