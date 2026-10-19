import {
  DEFAULT_CONFIRMATION_PARAGRAPH,
  OUTPUT_STYLE_IDENTITY_INTRO_PROMPT,
  SYSTEM_PROMPT_BACKGROUND_KEYS,
  SYSTEM_PROMPT_MAIN_PROMPT_ORDER,
  SYSTEM_PROMPT_PLACEHOLDERS,
  type SystemPromptOverrideKey,
  extractSystemPromptPlaceholders,
  normalizeSystemPromptText,
} from "@zcode/shared";
import type { SystemPromptSection } from "@zcode/services";
import { estimateStreamingTokens } from "@/v4/conversationStreamingThroughput.js";
import {
  diffOutputStylePrompt,
  MAX_DIFF_CELLS,
  type DiffLine,
} from "@/settings/outputStylesEditorModel.js";

export interface EditableSystemPromptSection extends SystemPromptSection {
  key: SystemPromptOverrideKey;
}

/**
 * Main-prompt sections follow their invocation order in ContextBuilder.build(); the background
 * Memory agent prompts (Extraction, /dream) come after them. Both come from shared definitions.
 */
export const SYSTEM_PROMPT_SECTION_DISPLAY_ORDER: readonly SystemPromptOverrideKey[] = [
  ...SYSTEM_PROMPT_MAIN_PROMPT_ORDER,
  ...SYSTEM_PROMPT_BACKGROUND_KEYS,
];

export const SYSTEM_PROMPT_SECTION_TITLE_IDS: Record<SystemPromptOverrideKey, string> = {
  "cli-prefix": "settings.systemPrompt.section.cliPrefix",
  "identity-intro": "settings.systemPrompt.section.identityIntro",
  harness: "settings.systemPrompt.section.harness",
  communication: "settings.systemPrompt.section.communication",
  "context-management": "settings.systemPrompt.section.contextManagement",
  "memory-guidance": "settings.systemPrompt.section.memoryGuidance",
  "memory-extraction": "settings.systemPrompt.section.memoryExtraction",
  "memory-dream": "settings.systemPrompt.section.memoryDream",
};

/** One-sentence row description ids: what the block does, where it sits, when it is active. */
export const SYSTEM_PROMPT_SECTION_INFO_IDS: Record<SystemPromptOverrideKey, string> = {
  "cli-prefix": "settings.systemPrompt.info.cliPrefix",
  "identity-intro": "settings.systemPrompt.info.identityIntro",
  harness: "settings.systemPrompt.info.harness",
  communication: "settings.systemPrompt.info.communication",
  "context-management": "settings.systemPrompt.info.contextManagement",
  "memory-guidance": "settings.systemPrompt.info.memoryGuidance",
  "memory-extraction": "settings.systemPrompt.info.memoryExtraction",
  "memory-dream": "settings.systemPrompt.info.memoryDream",
};

/** Placeholder guidance for sections whose `{{name}}` tokens the runtime substitutes. */
export const SYSTEM_PROMPT_SECTION_VARIABLE_HINTS: Partial<
  Record<SystemPromptOverrideKey, { id: string; values: Record<string, string> }>
> = {
  "memory-guidance": {
    id: "settings.systemPrompt.memoryRootHint",
    values: { placeholder: "{{memoryRoot}}" },
  },
  "memory-extraction": {
    id: "settings.systemPrompt.memoryExtractionHint",
    values: { countPlaceholder: "{{messageCount}}", listPlaceholder: "{{existingMemories}}" },
  },
  "memory-dream": {
    id: "settings.systemPrompt.memoryDreamHint",
    values: { rootPlaceholder: "{{memoryRoot}}", transcriptPlaceholder: "{{transcriptRoot}}" },
  },
};

/**
 * Background Memory agents never run for remote workspaces (memory spec §6/§7), so their
 * overrides would have no effect on a remote host and are not offered there.
 */
const LOCAL_ONLY_SYSTEM_PROMPT_KEYS: ReadonlySet<SystemPromptOverrideKey> = new Set(
  SYSTEM_PROMPT_BACKGROUND_KEYS,
);

export function isSystemPromptSectionOfferedOnHost(
  key: SystemPromptOverrideKey,
  isRemoteHost: boolean,
): boolean {
  return !isRemoteHost || !LOCAL_ONLY_SYSTEM_PROMPT_KEYS.has(key);
}

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

/** Dirty means the normalized text differs, so trailing whitespace alone is not a change. */
export function isSystemPromptDraftDirty(baseline: string, draft: string): boolean {
  return normalizeSystemPromptText(baseline) !== normalizeSystemPromptText(draft);
}

export function canSaveSystemPromptDraft(params: {
  baseline: string;
  draft: string;
  saving: boolean;
}): boolean {
  return (
    !params.saving &&
    normalizeSystemPromptText(params.draft).length > 0 &&
    isSystemPromptDraftDirty(params.baseline, params.draft)
  );
}

/** Why Save is unavailable, for the visible reason line. Null when saving is allowed. */
export type SystemPromptSaveBlockReason = "empty" | "unchanged" | "saving";

export function resolveSystemPromptSaveBlockReason(params: {
  baseline: string;
  draft: string;
  saving: boolean;
}): SystemPromptSaveBlockReason | null {
  if (canSaveSystemPromptDraft(params)) return null;
  if (params.saving) return "saving";
  if (normalizeSystemPromptText(params.draft).length === 0) return "empty";
  return "unchanged";
}

const systemPromptGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function countSystemPromptCharacters(text: string): number {
  let count = 0;
  for (const _segment of systemPromptGraphemeSegmenter.segment(text)) count += 1;
  return count;
}

/** Size line for a block: grapheme characters plus the approximate token estimate. */
export function describeSystemPromptSize(text: string): { characters: number; tokens: number } {
  return { characters: countSystemPromptCharacters(text), tokens: estimateStreamingTokens(text) };
}

export type SystemPromptDraftWarning =
  | { code: "unknown-placeholder"; token: string }
  | { code: "missing-placeholder"; token: string }
  | { code: "confirmation-removed" };

/**
 * Non-blocking draft warnings. Placeholder sets come from the shared defaults. A token that is
 * not in the key's set stays literal text at runtime, so it is reported as unknown. The
 * confirmation paragraph check applies only to `communication`, where that paragraph lives.
 */
export function validateSystemPromptDraft(
  key: SystemPromptOverrideKey,
  draft: string,
): SystemPromptDraftWarning[] {
  const warnings: SystemPromptDraftWarning[] = [];
  const supported = SYSTEM_PROMPT_PLACEHOLDERS[key];
  const present = extractSystemPromptPlaceholders(draft);
  for (const name of present) {
    if (!supported.includes(name)) {
      warnings.push({ code: "unknown-placeholder", token: `{{${name}}}` });
    }
  }
  for (const name of supported) {
    if (!present.includes(name)) {
      warnings.push({ code: "missing-placeholder", token: `{{${name}}}` });
    }
  }
  if (key === "communication" && !draft.includes(DEFAULT_CONFIRMATION_PARAGRAPH)) {
    warnings.push({ code: "confirmation-removed" });
  }
  return warnings;
}

export type SystemPromptDiff =
  | { kind: "same" }
  | { kind: "changed"; lines: DiffLine[] }
  | { kind: "too-large"; baselineLines: number; draftLines: number };

/**
 * Diff for the editor. Identical text is `same`. When the LCS table would exceed the cell budget
 * the result is `too-large` with the line counts, so the UI can say so instead of showing nothing.
 */
export function diffSystemPromptText(baseline: string, draft: string): SystemPromptDiff {
  if (baseline === draft) return { kind: "same" };
  const baselineLines = baseline.length === 0 ? 0 : baseline.split("\n").length;
  const draftLines = draft.length === 0 ? 0 : draft.split("\n").length;
  if ((baselineLines + 1) * (draftLines + 1) > MAX_DIFF_CELLS) {
    return { kind: "too-large", baselineLines, draftLines };
  }
  const lines = diffOutputStylePrompt(baseline, draft);
  return lines.some((line) => line.type !== "same") ? { kind: "changed", lines } : { kind: "same" };
}

export interface AssembledSystemPromptBlock {
  key: SystemPromptOverrideKey;
  text: string;
  tokens: number;
}

export interface AssembledSystemPromptPreview {
  blocks: AssembledSystemPromptBlock[];
  text: string;
  tokens: number;
}

/**
 * Approximate main-prompt assembly for the preview: effective block texts in runtime order,
 * joined by one blank line. Environment, memory index, tools and other runtime parts are not
 * included, so the caller must label the result as approximate.
 */
export function buildAssembledSystemPromptPreview(
  effectiveTexts: ReadonlyMap<SystemPromptOverrideKey, string>,
): AssembledSystemPromptPreview {
  const blocks = SYSTEM_PROMPT_MAIN_PROMPT_ORDER.flatMap((key) => {
    const text = effectiveTexts.get(key);
    return text === undefined ? [] : [{ key, text, tokens: estimateStreamingTokens(text) }];
  });
  const text = blocks.map((block) => block.text).join("\n\n");
  return { blocks, text, tokens: estimateStreamingTokens(text) };
}
