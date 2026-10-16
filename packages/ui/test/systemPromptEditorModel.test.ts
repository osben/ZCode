import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDENTITY_INTRO_PROMPT,
  DEFAULT_MEMORY_GUIDANCE_PROMPT,
  OUTPUT_STYLE_IDENTITY_INTRO_PROMPT,
  SYSTEM_PROMPT_OVERRIDE_KEYS,
} from "@zcode/shared";
import type { SystemPromptSection } from "@zcode/services";
import {
  canSaveSystemPromptDraft,
  orderedEditableSystemPromptSections,
  resolveEffectiveSystemPrompt,
  resolveSystemPromptDefault,
  SYSTEM_PROMPT_SECTION_DISPLAY_ORDER,
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
    ] satisfies (typeof SYSTEM_PROMPT_OVERRIDE_KEYS)[number][]);
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
