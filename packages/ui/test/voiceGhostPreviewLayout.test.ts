import { describe, expect, it } from "vitest";
import { computeGhostLayout, hasVoicePreviewText } from "@/lib/voiceGhostPreviewLayout.js";

const editor = { left: 100, top: 50, width: 400, height: 120 };

describe("computeGhostLayout (VD-GHO-04)", () => {
  it("places the first line at the caret x and aligns the line box with the caret line", () => {
    const layout = computeGhostLayout({
      caret: { left: 180, top: 60, height: 16 },
      editor,
      lineHeight: 20,
    });
    // Caret x relative to the editor box; the first line is indented by this amount only.
    expect(layout?.indent).toBe(80);
    // Half of the 4px leading above the caret glyph box keeps the ghost on the editor's line grid.
    expect(layout?.top).toBe(10 - 2);
  });

  it("clamps the first-line indent inside the editor box", () => {
    expect(
      computeGhostLayout({ caret: { left: 20, top: 60, height: 16 }, editor, lineHeight: 20 })
        ?.indent,
    ).toBe(0);
  });

  it("keeps the insertion position near the right edge instead of shifting the ghost left", () => {
    // Caret 390px from the editor's left edge: the ghost starts there and wraps, never moves back over the draft.
    const nearRight = computeGhostLayout({
      caret: { left: 100 + 390, top: 60, height: 16 },
      editor,
      lineHeight: 20,
    });
    expect(nearRight?.indent).toBe(390);
  });

  it("hides the ghost when the caret is scrolled outside the visible editor box", () => {
    expect(
      computeGhostLayout({ caret: { left: 180, top: 10, height: 16 }, editor, lineHeight: 20 }),
    ).toBeNull();
    expect(
      computeGhostLayout({ caret: { left: 180, top: 200, height: 16 }, editor, lineHeight: 20 }),
    ).toBeNull();
  });

  it("keeps a fully visible last-line caret whose line box would overflow the editor", () => {
    // Only the caret glyph box must fit; the line box's leading below it is not visible.
    const shortEditor = { left: 100, top: 50, width: 400, height: 40 };
    expect(
      computeGhostLayout({
        caret: { left: 180, top: 72, height: 16 },
        editor: shortEditor,
        lineHeight: 20,
      }),
    ).toEqual({ top: 20, indent: 80 });
  });

  it("hides the ghost when the caret glyph itself extends past the editor bottom", () => {
    const shortEditor = { left: 100, top: 50, width: 400, height: 40 };
    expect(
      computeGhostLayout({
        caret: { left: 180, top: 75, height: 16 },
        editor: shortEditor,
        lineHeight: 20,
      }),
    ).toBeNull();
  });

  it("returns null for an editor with no usable width", () => {
    expect(
      computeGhostLayout({
        caret: { left: 0, top: 60, height: 16 },
        editor: { ...editor, width: 0 },
        lineHeight: 20,
      }),
    ).toBeNull();
  });

  it("never reports a negative top when the line height is smaller than the caret box", () => {
    const layout = computeGhostLayout({
      caret: { left: 120, top: 50, height: 24 },
      editor,
      lineHeight: 16,
    });
    expect(layout?.top).toBe(0);
  });
});

describe("hasVoicePreviewText (VD-GHO-08)", () => {
  it("is true when either committed or tentative text exists", () => {
    expect(hasVoicePreviewText({ committed: "hello", tentative: "" })).toBe(true);
    expect(hasVoicePreviewText({ committed: "", tentative: "wor" })).toBe(true);
  });

  it("is false for no preview or an empty preview so the placeholder returns", () => {
    expect(hasVoicePreviewText(null)).toBe(false);
    expect(hasVoicePreviewText(undefined)).toBe(false);
    expect(hasVoicePreviewText({ committed: "", tentative: "" })).toBe(false);
  });
});
