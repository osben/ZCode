import { outputStyleFilenameFromName, type OutputStyle } from "@zcode/shared";

/** Draft of the style editor; `styleId: null` means a new custom style is being created. */
export interface OutputStyleDraft {
  styleId: string | null;
  name: string;
  description: string;
  content: string;
}

export type OutputStyleNameCollision = "builtin-override" | "custom-collision" | "reserved-default";

const CUSTOM_ID_PREFIX = "custom-";

export function outputStyleIdFromFilename(filename: string): string {
  return `${CUSTOM_ID_PREFIX}${filename.replace(/\.md$/, "")}`;
}

export function baseStyleId(styleId: string): string {
  return styleId.startsWith(CUSTOM_ID_PREFIX) ? styleId.slice(CUSTOM_ID_PREFIX.length) : styleId;
}

/**
 * Display-only path join for the editor's future-file hints. The directory comes from the
 * target host, so honor either separator style it ends with; this is not used for file IO.
 */
export function outputStyleFilePath(directory: string, filename: string): string {
  return /[\\/]$/.test(directory) ? `${directory}${filename}` : `${directory}/${filename}`;
}

export function isOutputStyleDraftDirty(
  draft: OutputStyleDraft,
  baseline: OutputStyleDraft | null,
): boolean {
  if (baseline === null) {
    // A new draft is dirty once ANY field has content; the name is only a save gate, so
    // navigation guards must not silently drop a description or prompt typed before a name.
    return Boolean(draft.name.trim() || draft.description.trim() || draft.content.trim());
  }
  return (
    draft.name !== baseline.name ||
    draft.description !== baseline.description ||
    draft.content !== baseline.content
  );
}

export function canSaveOutputStyleDraft(input: {
  draft: OutputStyleDraft;
  baseline: OutputStyleDraft | null;
  saving: boolean;
}): boolean {
  if (input.saving) return false;
  if (!input.draft.name.trim()) return false;
  return isOutputStyleDraftDirty(input.draft, input.baseline);
}

/**
 * Detect id collisions the filename derivation would cause for a NEW style: a slug matching a
 * built-in id would silently override that built-in, and matching an existing custom id would
 * overwrite its file. The `default` slug is reserved — the runtime treats it as "no style" and
 * ignores any override for it, so such a save can never take effect. Edits never collide
 * because the service keeps the existing file name.
 */
export function detectOutputStyleNameCollision(
  draft: OutputStyleDraft,
  styles: readonly OutputStyle[],
): OutputStyleNameCollision | null {
  if (draft.styleId !== null) return null;
  const name = draft.name.trim();
  if (!name) return null;
  const targetId = outputStyleIdFromFilename(outputStyleFilenameFromName(name));
  if (baseStyleId(targetId) === "default") return "reserved-default";
  for (const style of styles) {
    // Case-insensitive for custom ids: default macOS/Windows filesystems treat Tone.md and
    // tone.md as the same file, so a case-only match must still warn.
    const collides = style.isBuiltIn
      ? style.id === baseStyleId(targetId)
      : style.id.toLowerCase() === targetId.toLowerCase();
    if (collides) {
      return style.isBuiltIn ? "builtin-override" : "custom-collision";
    }
  }
  return null;
}

/** A custom style whose prompt is empty resolves to nothing at runtime (docs/output-styles-settings.md). */
export function isEmptyOutputStylePrompt(draft: OutputStyleDraft): boolean {
  return draft.content.trim().length === 0;
}

/**
 * Save-time conflict check: the style's stored fields changed on disk since the editor opened
 * (another window / the agent itself edited the file).
 */
export function isOutputStyleConflict(
  baseline: OutputStyleDraft,
  current: { name: string; description: string; content: string },
): boolean {
  return (
    baseline.name !== current.name ||
    baseline.description !== current.description ||
    baseline.content !== current.content
  );
}

export type DiffLineType = "same" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Small LCS line diff for the save preview. Style prompts are short; the O(n*m) table is fine
 * and keeps this dependency-free and testable. Identical inputs short-circuit, and oversized
 * bodies (a huge hand-created file) skip the preview instead of freezing the renderer.
 */
export function diffOutputStylePrompt(previous: string, next: string): DiffLine[] {
  if (previous === next) return [];
  const previousLines = previous.length === 0 ? [] : previous.split("\n");
  const nextLines = next.length === 0 ? [] : next.split("\n");
  const rows = previousLines.length;
  const cols = nextLines.length;
  const MAX_DIFF_CELLS = 4_000_000;
  if ((rows + 1) * (cols + 1) > MAX_DIFF_CELLS) return [];
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] =
        previousLines[i] === nextLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (previousLines[i] === nextLines[j]) {
      result.push({ type: "same", text: previousLines[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ type: "remove", text: previousLines[i]! });
      i += 1;
    } else {
      result.push({ type: "add", text: nextLines[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    result.push({ type: "remove", text: previousLines[i]! });
    i += 1;
  }
  while (j < cols) {
    result.push({ type: "add", text: nextLines[j]! });
    j += 1;
  }
  return result;
}

export function hasDiffChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((line) => line.type !== "same");
}

/** Build an editor draft from a listed style, or an empty draft for a new custom style. */
export function draftFromStyle(style: OutputStyle): OutputStyleDraft {
  return {
    styleId: style.id,
    name: style.name,
    description: style.description,
    content: style.content,
  };
}

export function emptyOutputStyleDraft(): OutputStyleDraft {
  return { styleId: null, name: "", description: "", content: "" };
}
