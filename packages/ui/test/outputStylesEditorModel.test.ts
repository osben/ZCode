import { describe, expect, it } from "vitest";
import {
  outputStyleFilenameFromName,
  safeOutputStyleFilenameFromId,
  type OutputStyle,
} from "@zcode/shared";
import {
  baseStyleId,
  canSaveOutputStyleDraft,
  detectOutputStyleNameCollision,
  diffOutputStylePrompt,
  draftFromStyle,
  emptyOutputStyleDraft,
  hasDiffChanges,
  isEmptyOutputStylePrompt,
  isOutputStyleConflict,
  isOutputStyleDraftDirty,
  outputStyleFilePath,
  outputStyleIdFromFilename,
  type OutputStyleDraft,
} from "../src/settings/outputStylesEditorModel.js";

function builtinStyle(overrides: Partial<OutputStyle> = {}): OutputStyle {
  return {
    id: "explanatory",
    name: "Explanatory",
    description: "Explains implementation choices",
    content: "Explain your choices.",
    isBuiltIn: true,
    enabled: false,
    ...overrides,
  };
}

function customStyle(overrides: Partial<OutputStyle> = {}): OutputStyle {
  return {
    id: "custom-concise",
    name: "Concise",
    description: "Short responses",
    content: "Be brief.",
    isBuiltIn: false,
    enabled: false,
    ...overrides,
  };
}

describe("outputStyleFilenameFromName", () => {
  it("mirrors the service slug derivation", () => {
    expect(outputStyleFilenameFromName("Concise Reviews")).toBe("concise-reviews.md");
    expect(outputStyleFilenameFromName("  Tone  v2 ")).toBe("tone-v2.md");
    expect(outputStyleIdFromFilename("tone-v2.md")).toBe("custom-tone-v2");
  });

  it("sanitizes names so they cannot traverse out of the styles directory", () => {
    expect(outputStyleFilenameFromName("a/b\\c")).toBe("abc.md");
    expect(outputStyleFilenameFromName("../../.ssh/evil")).toBe(".....sshevil.md");
    expect(outputStyleFilenameFromName("!!!")).toBe("style.md");
    // Existing ids keep their casing but still drop separators.
    expect(safeOutputStyleFilenameFromId("custom-MyStyle")).toBe("MyStyle.md");
    expect(safeOutputStyleFilenameFromId("../x")).toBe("..x.md");
    // A hand-named foo.md.md file lists as custom-foo.md; edit/delete must map back to it
    // (listing already removed one extension, so no further .md is stripped).
    expect(safeOutputStyleFilenameFromId("custom-foo.md")).toBe("foo.md.md");
  });

  it("strips only the custom- prefix for base ids", () => {
    expect(baseStyleId("custom-tone")).toBe("tone");
    expect(baseStyleId("explanatory")).toBe("explanatory");
  });

  it("joins host directories with either separator style for display", () => {
    expect(outputStyleFilePath("/home/u/.zcode/output-styles", "tone.md")).toBe(
      "/home/u/.zcode/output-styles/tone.md",
    );
    expect(outputStyleFilePath("C:\\Users\\u\\.zcode\\output-styles\\", "tone.md")).toBe(
      "C:\\Users\\u\\.zcode\\output-styles\\tone.md",
    );
  });
});

describe("isOutputStyleDraftDirty", () => {
  it("treats a new draft as dirty once any field has content", () => {
    expect(isOutputStyleDraftDirty(emptyOutputStyleDraft(), null)).toBe(false);
    expect(isOutputStyleDraftDirty({ ...emptyOutputStyleDraft(), name: "New" }, null)).toBe(true);
    // Description or prompt typed before a name must not be silently discarded on navigation.
    expect(isOutputStyleDraftDirty({ ...emptyOutputStyleDraft(), description: "d" }, null)).toBe(
      true,
    );
    expect(isOutputStyleDraftDirty({ ...emptyOutputStyleDraft(), content: "p" }, null)).toBe(true);
  });

  it("detects field changes against the baseline", () => {
    const baseline: OutputStyleDraft = draftFromStyle(customStyle());
    expect(isOutputStyleDraftDirty(baseline, baseline)).toBe(false);
    expect(isOutputStyleDraftDirty({ ...baseline, content: "x" }, baseline)).toBe(true);
    expect(isOutputStyleDraftDirty({ ...baseline, description: "y" }, baseline)).toBe(true);
  });
});

describe("canSaveOutputStyleDraft", () => {
  const baseline: OutputStyleDraft = draftFromStyle(customStyle());

  it("requires a name and a change", () => {
    expect(
      canSaveOutputStyleDraft({ draft: emptyOutputStyleDraft(), baseline: null, saving: false }),
    ).toBe(false);
    expect(
      canSaveOutputStyleDraft({
        draft: { ...emptyOutputStyleDraft(), name: "Named" },
        baseline: null,
        saving: false,
      }),
    ).toBe(true);
    expect(canSaveOutputStyleDraft({ draft: baseline, baseline, saving: false })).toBe(false);
    expect(
      canSaveOutputStyleDraft({ draft: { ...baseline, name: "x" }, baseline, saving: false }),
    ).toBe(true);
  });

  it("blocks while saving", () => {
    expect(
      canSaveOutputStyleDraft({
        draft: { ...baseline, name: "x" },
        baseline,
        saving: true,
      }),
    ).toBe(false);
  });
});

describe("detectOutputStyleNameCollision", () => {
  it("warns when a new style's name would override a built-in style", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "Explanatory" };
    expect(detectOutputStyleNameCollision(draft, [builtinStyle()])).toBe("builtin-override");
  });

  it("warns when a new style's name would overwrite an existing custom style", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "Concise" };
    expect(detectOutputStyleNameCollision(draft, [customStyle()])).toBe("custom-collision");
  });

  it("never warns while editing an existing style: the file name stays fixed", () => {
    // Editing a custom style without renaming…
    const editingCustom: OutputStyleDraft = {
      ...emptyOutputStyleDraft(),
      styleId: "custom-concise",
      name: "Concise",
    };
    expect(detectOutputStyleNameCollision(editingCustom, [customStyle()])).toBeNull();
    // …customizing a built-in under its own name…
    const editingBuiltin: OutputStyleDraft = {
      ...emptyOutputStyleDraft(),
      styleId: "explanatory",
      name: "Explanatory",
    };
    expect(detectOutputStyleNameCollision(editingBuiltin, [builtinStyle()])).toBeNull();
    // …and renaming, which only edits the header inside the existing file.
    const renaming: OutputStyleDraft = {
      ...emptyOutputStyleDraft(),
      styleId: "custom-concise",
      name: "Tone",
    };
    const otherTone = customStyle({ id: "custom-tone", name: "Tone" });
    expect(detectOutputStyleNameCollision(renaming, [customStyle(), otherTone])).toBeNull();
  });

  it("flags an overridden built-in for a new style with the same slug", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "Explanatory" };
    expect(detectOutputStyleNameCollision(draft, [builtinStyle({ isOverridden: true })])).toBe(
      "builtin-override",
    );
  });

  it("blocks the reserved default slug: the runtime ignores overrides for it", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "Default" };
    expect(detectOutputStyleNameCollision(draft, [])).toBe("reserved-default");
  });

  it("matches custom collisions case-insensitively for macOS/Windows filesystems", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "tone" };
    const handCreated = customStyle({ id: "custom-Tone", name: "Tone" });
    expect(detectOutputStyleNameCollision(draft, [handCreated])).toBe("custom-collision");
  });

  it("returns null for unique names", () => {
    const draft: OutputStyleDraft = { ...emptyOutputStyleDraft(), name: "Review Focus" };
    expect(detectOutputStyleNameCollision(draft, [builtinStyle(), customStyle()])).toBeNull();
  });
});

describe("isEmptyOutputStylePrompt / isOutputStyleConflict", () => {
  it("treats whitespace-only prompts as empty", () => {
    expect(
      isEmptyOutputStylePrompt({ ...emptyOutputStyleDraft(), name: "x", content: " \n " }),
    ).toBe(true);
  });

  it("detects external changes by field comparison", () => {
    const baseline = draftFromStyle(customStyle());
    expect(
      isOutputStyleConflict(baseline, {
        name: "Concise",
        description: "Short responses",
        content: "Be brief.",
      }),
    ).toBe(false);
    expect(
      isOutputStyleConflict(baseline, {
        name: "Concise",
        description: "Short responses",
        content: "Changed.",
      }),
    ).toBe(true);
  });
});

describe("diffOutputStylePrompt", () => {
  it("marks added and removed lines", () => {
    const lines = diffOutputStylePrompt("a\nb\nc", "a\nx\nc\nd");
    expect(lines.filter((line) => line.type === "remove").map((line) => line.text)).toEqual(["b"]);
    expect(lines.filter((line) => line.type === "add").map((line) => line.text)).toEqual([
      "x",
      "d",
    ]);
    expect(hasDiffChanges(lines)).toBe(true);
  });

  it("returns only same lines for identical prompts", () => {
    const lines = diffOutputStylePrompt("a\nb", "a\nb");
    expect(lines.every((line) => line.type === "same")).toBe(true);
    expect(hasDiffChanges(lines)).toBe(false);
  });

  it("handles empty sides", () => {
    const lines = diffOutputStylePrompt("", "new\nprompt");
    expect(lines.map((line) => line.type)).toEqual(["add", "add"]);
    expect(diffOutputStylePrompt("old", "").map((line) => line.type)).toEqual(["remove"]);
  });

  it("short-circuits identical prompts and skips oversized bodies", () => {
    expect(diffOutputStylePrompt("same", "same")).toEqual([]);
    // Two ~2100-line bodies exceed the cell cap; the preview degrades to "no diff" instead
    // of allocating a quadratic table in the renderer.
    const big = `${Array.from({ length: 2100 }, (_, i) => `line-${i}`).join("\n")}`;
    const bigChanged = `${big}\nextra`;
    expect(diffOutputStylePrompt(big, bigChanged)).toEqual([]);
  });
});
