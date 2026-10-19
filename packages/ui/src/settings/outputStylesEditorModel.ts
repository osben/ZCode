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

/** LCS table cell budget; past it the diff is skipped instead of computed (see diffOutputStylePrompt). */
export const MAX_DIFF_CELLS = 4_000_000;

/**
 * Small LCS line diff for the save preview. Style prompts are short; the table is one flat
 * Int32Array over the lines after the shared leading run, and identical inputs short-circuit.
 * Returns null when the full line counts exceed MAX_DIFF_CELLS, so an oversized body (a huge
 * hand-created file) skips the preview instead of freezing the renderer.
 */
export function diffOutputStylePrompt(previous: string, next: string): DiffLine[] | null {
  if (previous === next) return [];
  const previousLines = previous.length === 0 ? [] : previous.split("\n");
  const nextLines = next.length === 0 ? [] : next.split("\n");
  // The budget uses the full line counts, so the too-large boundary does not move with trimming.
  if ((previousLines.length + 1) * (nextLines.length + 1) > MAX_DIFF_CELLS) return null;
  const result: DiffLine[] = [];
  // A shared leading line is emitted as "same" by the LCS walk below too, so trimming the run
  // before the table keeps the output identical. Trailing runs are not trimmed: the walk can
  // order a tied same/add pair differently after trimming, which would change the preview.
  const sharedLeading = Math.min(previousLines.length, nextLines.length);
  let start = 0;
  while (start < sharedLeading && previousLines[start] === nextLines[start]) {
    result.push({ type: "same", text: previousLines[start]! });
    start += 1;
  }
  const rows = previousLines.length - start;
  const cols = nextLines.length - start;
  const width = cols + 1;
  // table[i * width + j] = LCS length of previousLines[start + i..] and nextLines[start + j..].
  const table = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        previousLines[start + i] === nextLines[start + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    const previousLine = previousLines[start + i]!;
    if (previousLine === nextLines[start + j]) {
      result.push({ type: "same", text: previousLine });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      result.push({ type: "remove", text: previousLine });
      i += 1;
    } else {
      result.push({ type: "add", text: nextLines[start + j]! });
      j += 1;
    }
  }
  while (i < rows) {
    result.push({ type: "remove", text: previousLines[start + i]! });
    i += 1;
  }
  while (j < cols) {
    result.push({ type: "add", text: nextLines[start + j]! });
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
