import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDENTITY_INTRO_PROMPT,
  DEFAULT_MEMORY_GUIDANCE_PROMPT,
  OUTPUT_STYLE_IDENTITY_INTRO_PROMPT,
  SYSTEM_PROMPT_DEFAULTS,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
  type SystemPromptOverrideKey,
} from "@zcode/shared";
import type { SystemPromptSection } from "@zcode/services";
import {
  buildAssembledSystemPromptPreview,
  canSaveSystemPromptDraft,
  diffSystemPromptText,
  describeSystemPromptSize,
  isSystemPromptDraftDirty,
  resolveSystemPromptSaveBlockReason,
  validateSystemPromptDraft,
  orderedEditableSystemPromptSections,
  resolveEffectiveSystemPrompt,
  resolveSystemPromptDefault,
  SYSTEM_PROMPT_SECTION_DISPLAY_ORDER,
  SYSTEM_PROMPT_SECTION_VARIABLE_HINTS,
  isSystemPromptSectionOfferedOnHost,
} from "../src/settings/systemPromptEditorModel.js";

function section(key: string, overrideContent: string | null = null): SystemPromptSection {
  return {
    key,
    defaultContent: key === "identity-intro" ? DEFAULT_IDENTITY_INTRO_PROMPT : `default:${key}`,
    overrideContent,
    filePath: `/home/.zcode/system-prompt/${key}.md`,
    isOverridden: overrideContent !== null,
    revision: null,
  };
}

describe("systemPromptEditorModel", () => {
  it("keeps only whitelisted sections and follows ContextBuilder invocation order", () => {
    const values = [
      section("protected-security-notice"),
      ...[...SYSTEM_PROMPT_OVERRIDE_KEYS].reverse().map((key) => section(key)),
    ];

    expect(orderedEditableSystemPromptSections(values).map((entry) => entry.key)).toEqual(
      SYSTEM_PROMPT_SECTION_DISPLAY_ORDER,
    );
    expect(SYSTEM_PROMPT_SECTION_DISPLAY_ORDER).toEqual([
      "cli-prefix",
      "identity-intro",
      "harness",
      "communication",
      "memory-guidance",
      "context-management",
      "memory-extraction",
      "memory-dream",
    ] satisfies (typeof SYSTEM_PROMPT_OVERRIDE_KEYS)[number][]);
  });

  it("hides the background Memory agent sections on a remote host only", () => {
    expect(isSystemPromptSectionOfferedOnHost("memory-extraction", false)).toBe(true);
    expect(isSystemPromptSectionOfferedOnHost("memory-dream", false)).toBe(true);
    expect(isSystemPromptSectionOfferedOnHost("memory-extraction", true)).toBe(false);
    expect(isSystemPromptSectionOfferedOnHost("memory-dream", true)).toBe(false);
    expect(isSystemPromptSectionOfferedOnHost("memory-guidance", true)).toBe(true);
  });

  it("shows placeholder guidance only for sections that the runtime substitutes", () => {
    expect(Object.keys(SYSTEM_PROMPT_SECTION_VARIABLE_HINTS).sort()).toEqual([
      "memory-dream",
      "memory-extraction",
      "memory-guidance",
    ]);
    for (const [key, hint] of Object.entries(SYSTEM_PROMPT_SECTION_VARIABLE_HINTS)) {
      const template = SYSTEM_PROMPT_DEFAULTS[key as SystemPromptOverrideKey];
      for (const placeholder of Object.values(hint.values)) {
        expect(template, `${key} default must contain ${placeholder}`).toContain(placeholder);
      }
    }
  });

  it("uses the active Output Style identity intro as the default baseline", () => {
    const identity = section("identity-intro");

    expect(resolveSystemPromptDefault(identity, false)).toBe(DEFAULT_IDENTITY_INTRO_PROMPT);
    expect(resolveSystemPromptDefault(identity, true)).toBe(OUTPUT_STYLE_IDENTITY_INTRO_PROMPT);
  });

  it("keeps an explicit identity override effective with an active Output Style", () => {
    const identity = section("identity-intro", "My identity intro");

    expect(resolveEffectiveSystemPrompt(identity, resolveSystemPromptDefault(identity, true))).toBe(
      "My identity intro",
    );
  });

  it("retains the literal memoryRoot placeholder in the built-in guidance", () => {
    expect(DEFAULT_MEMORY_GUIDANCE_PROMPT).toContain("{{memoryRoot}}");
  });

  it("does not allow blank or unchanged drafts to create an override", () => {
    expect(canSaveSystemPromptDraft({ baseline: "default", draft: "   ", saving: false })).toBe(
      false,
    );
    expect(canSaveSystemPromptDraft({ baseline: "same", draft: "same", saving: false })).toBe(
      false,
    );
    expect(canSaveSystemPromptDraft({ baseline: "default", draft: "custom", saving: true })).toBe(
      false,
    );
    expect(canSaveSystemPromptDraft({ baseline: "default", draft: "custom", saving: false })).toBe(
      true,
    );
  });
});

describe("systemPromptEditorModel dirty and save rules", () => {
  it("treats whitespace-only edits as clean, matching the trimmed write", () => {
    expect(isSystemPromptDraftDirty("Terse.", "Terse.\n\n")).toBe(false);
    expect(isSystemPromptDraftDirty("Terse.", "Terse. more")).toBe(true);
    expect(canSaveSystemPromptDraft({ baseline: "Terse.", draft: "Terse.\n", saving: false })).toBe(
      false,
    );
  });

  it("explains why Save is unavailable", () => {
    expect(resolveSystemPromptSaveBlockReason({ baseline: "x", draft: "  ", saving: false })).toBe(
      "empty",
    );
    expect(resolveSystemPromptSaveBlockReason({ baseline: "x", draft: "x", saving: false })).toBe(
      "unchanged",
    );
    expect(resolveSystemPromptSaveBlockReason({ baseline: "x", draft: "y", saving: true })).toBe(
      "saving",
    );
    expect(
      resolveSystemPromptSaveBlockReason({ baseline: "x", draft: "y", saving: false }),
    ).toBeNull();
  });
});

describe("systemPromptEditorModel validation", () => {
  it("derives required placeholders from the shared defaults", () => {
    expect(
      validateSystemPromptDraft("memory-extraction", SYSTEM_PROMPT_DEFAULTS["memory-extraction"]),
    ).toEqual([]);
    expect(validateSystemPromptDraft("memory-extraction", "Only {{messageCount}} here.")).toEqual([
      { code: "missing-placeholder", token: "{{existingMemories}}" },
    ]);
    expect(validateSystemPromptDraft("memory-guidance", "Memory at {{memoryRoot}}.")).toEqual([]);
  });

  it("warns about unknown tokens, including tokens in sections that have no placeholders", () => {
    expect(validateSystemPromptDraft("memory-guidance", "{{memoryRoot}} and {{typo}}")).toEqual([
      { code: "unknown-placeholder", token: "{{typo}}" },
    ]);
    expect(validateSystemPromptDraft("harness", "Use {{memoryRoot}} here")).toEqual([
      { code: "unknown-placeholder", token: "{{memoryRoot}}" },
    ]);
  });

  it("warns when the confirmation paragraph is removed from communication only", () => {
    expect(validateSystemPromptDraft("communication", "Short draft.")).toEqual([
      { code: "confirmation-removed" },
    ]);
    expect(
      validateSystemPromptDraft("communication", SYSTEM_PROMPT_DEFAULTS.communication),
    ).toEqual([]);
    expect(validateSystemPromptDraft("harness", "Short draft.")).toEqual([]);
  });
});

describe("systemPromptEditorModel diff and size", () => {
  it("reports identical text as same and a changed draft as changed lines", () => {
    expect(diffSystemPromptText("a\nb", "a\nb")).toEqual({ kind: "same" });
    const diff = diffSystemPromptText("a\nb", "a\nc");
    expect(diff.kind).toBe("changed");
    if (diff.kind === "changed") {
      expect(diff.lines.map((line) => line.type)).toEqual(["same", "remove", "add"]);
    }
  });

  it("returns an explicit too-large state instead of an empty diff", () => {
    const big = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n");
    const bigger = `${big}\nextra`;
    const diff = diffSystemPromptText(big, bigger);
    expect(diff).toEqual({ kind: "too-large", baselineLines: 2100, draftLines: 2101 });
  });

  it("counts graphemes and estimates tokens from the shared estimator", () => {
    expect(describeSystemPromptSize("éa")).toEqual({
      characters: 2,
      tokens: expect.any(Number),
    });
    expect(describeSystemPromptSize("").tokens).toBe(0);
  });
});

describe("systemPromptEditorModel assembled preview", () => {
  it("concatenates main-prompt blocks in runtime order and skips background agents", () => {
    const texts = new Map<SystemPromptOverrideKey, string>([
      ["context-management", "CM"],
      ["memory-extraction", "EXTRACTION"],
      ["cli-prefix", "CLI"],
      ["communication", "COMM"],
      ["harness", "HARNESS"],
      ["identity-intro", "INTRO"],
      ["memory-guidance", "MEM"],
    ]);
    const preview = buildAssembledSystemPromptPreview(texts);
    expect(preview.blocks.map((block) => block.key)).toEqual([
      "cli-prefix",
      "identity-intro",
      "harness",
      "communication",
      "memory-guidance",
      "context-management",
    ]);
    expect(preview.text).toBe("CLI\n\nINTRO\n\nHARNESS\n\nCOMM\n\nMEM\n\nCM");
    expect(preview.tokens).toBeGreaterThan(0);
  });
});
