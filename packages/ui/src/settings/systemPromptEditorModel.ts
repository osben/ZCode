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
  hasDiffChanges,
  type DiffLine,
} from "@/settings/outputStylesEditorModel.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Intl handle type shared by the System Prompts settings components. */
export type SystemPromptIntl = ReturnType<typeof useZCodeIntl>["intl"];

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

export interface SystemPromptEditorState {
  key: SystemPromptOverrideKey;
  /** Effective text when the editor opened (or was last rebased onto disk). "Changes vs saved" compares to it. */
  baseline: string;
  draft: string;
  saving: boolean;
  /**
   * Section revision the draft was based on. `undefined` on hosts without revisions, which turns
   * conflict checking off for this editor.
   */
  baseRevision: string | null | undefined;
}

/** A fresh editor on `effectiveContent`; the revision is the one the draft is based on. */
export function makeEditorState(
  key: SystemPromptOverrideKey,
  effectiveContent: string,
  baseRevision: string | null | undefined,
): SystemPromptEditorState {
  return { key, baseline: effectiveContent, draft: effectiveContent, saving: false, baseRevision };
}

export function revisionOf(
  sections: readonly EditableSystemPromptSection[],
  key: SystemPromptOverrideKey,
): string | null | undefined {
  return sections.find((candidate) => candidate.key === key)?.revision;
}

/** Listings compare by the fields the UI renders and the save path reads. */
function sameSectionState(a: EditableSystemPromptSection, b: EditableSystemPromptSection): boolean {
  return (
    a.key === b.key &&
    a.revision === b.revision &&
    a.overrideContent === b.overrideContent &&
    a.defaultContent === b.defaultContent &&
    a.isOverridden === b.isOverridden &&
    a.filePath === b.filePath
  );
}

export function sameSections(
  a: readonly EditableSystemPromptSection[],
  b: readonly EditableSystemPromptSection[],
): boolean {
  return a.length === b.length && a.every((section, index) => sameSectionState(section, b[index]!));
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
  return [...systemPromptGraphemeSegmenter.segment(text)].length;
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

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Diff for the editor. Text with no changed line is `same`. When the diff exceeds the cell budget
 * the result is `too-large` with the line counts, so the UI can say so instead of showing nothing.
 */
export function diffSystemPromptText(baseline: string, draft: string): SystemPromptDiff {
  const lines = diffOutputStylePrompt(baseline, draft);
  if (lines === null) {
    return {
      kind: "too-large",
      baselineLines: countLines(baseline),
      draftLines: countLines(draft),
    };
  }
  return hasDiffChanges(lines) ? { kind: "changed", lines } : { kind: "same" };
}

/**
 * Approximate main-prompt assembly for the preview: effective block texts in runtime order,
 * joined by one blank line. Environment, memory index, tools and other runtime parts are not
 * included, so the caller must label the result as approximate.
 */
export function buildAssembledSystemPromptText(
  effectiveTexts: ReadonlyMap<SystemPromptOverrideKey, string>,
): string {
  return SYSTEM_PROMPT_MAIN_PROMPT_ORDER.flatMap((key) => {
    const text = effectiveTexts.get(key);
    return text === undefined ? [] : [text];
  }).join("\n\n");
}
