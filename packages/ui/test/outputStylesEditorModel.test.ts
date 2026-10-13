import { describe, expect, it } from "vitest";
import type { OutputStyle } from "@zcode/shared";
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
  outputStyleFilenameFromName,
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

  it("strips only the custom- prefix for base ids", () => {
    expect(baseStyleId("custom-tone")).toBe("tone");
    expect(baseStyleId("explanatory")).toBe("explanatory");
  });
});

describe("isOutputStyleDraftDirty", () => {
  it("treats a new draft as dirty once it has a name", () => {
    expect(isOutputStyleDraftDirty(emptyOutputStyleDraft(), null)).toBe(false);
    expect(isOutputStyleDraftDirty({ ...emptyOutputStyleDraft(), name: "New" }, null)).toBe(true);
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
});
