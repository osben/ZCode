import { OUTPUT_STYLE_IDENTITY_INTRO_PROMPT, type SystemPromptOverrideKey } from "@zcode/shared";
import type { SystemPromptSection } from "@zcode/services";

export interface EditableSystemPromptSection extends SystemPromptSection {
  key: SystemPromptOverrideKey;
}

/** Display order follows the editable sections' invocation order in ContextBuilder.build(). */
export const SYSTEM_PROMPT_SECTION_DISPLAY_ORDER: readonly SystemPromptOverrideKey[] = [
  "cli-prefix",
  "identity-intro",
  "harness",
  "communication",
  "memory-guidance",
  "context-management",
];

export const SYSTEM_PROMPT_SECTION_TITLE_IDS: Record<SystemPromptOverrideKey, string> = {
  "cli-prefix": "settings.systemPrompt.section.cliPrefix",
  "identity-intro": "settings.systemPrompt.section.identityIntro",
  harness: "settings.systemPrompt.section.harness",
  communication: "settings.systemPrompt.section.communication",
  "context-management": "settings.systemPrompt.section.contextManagement",
  "memory-guidance": "settings.systemPrompt.section.memoryGuidance",
};

export function orderedEditableSystemPromptSections(
  sections: readonly SystemPromptSection[],
): EditableSystemPromptSection[] {
  return SYSTEM_PROMPT_SECTION_DISPLAY_ORDER.flatMap((key) => {
    const section = sections.find((candidate) => candidate.key === key);
    return section ? [{ ...section, key }] : [];
  });
}

export function resolveSystemPromptDefault(
  section: EditableSystemPromptSection,
  hasActiveOutputStyle: boolean,
): string {
  return section.key === "identity-intro" && hasActiveOutputStyle
    ? OUTPUT_STYLE_IDENTITY_INTRO_PROMPT
    : section.defaultContent;
}

export function resolveEffectiveSystemPrompt(
  section: EditableSystemPromptSection,
  effectiveDefault: string,
): string {
  return section.overrideContent ?? effectiveDefault;
}

export function canSaveSystemPromptDraft(params: {
  baseline: string;
  draft: string;
  saving: boolean;
}): boolean {
  return !params.saving && params.draft.trim().length > 0 && params.draft !== params.baseline;
}

export function isSystemPromptDraftDirty(baseline: string, draft: string): boolean {
  return baseline !== draft;
}

const systemPromptGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function countSystemPromptCharacters(text: string): number {
  let count = 0;
  for (const _segment of systemPromptGraphemeSegmenter.segment(text)) count += 1;
  return count;
}
