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
  canSaveSystemPromptDraft,
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
