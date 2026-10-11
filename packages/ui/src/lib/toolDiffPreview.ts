import { trimPatchContext } from "@pierre/diffs";

const MAX_DIFF_LCS_CELLS = 60_000;

interface LineMatch {
  beforeIndex: number;
  afterIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

export function extractBeforeAfter(value: unknown): { before: string; after: string } | null {
  if (!isRecord(value)) {
    return null;
  }

  const before = findStringField(value, ["before", "old_string", "oldText", "oldContent"]);
  const after = findStringField(value, ["after", "new_string", "newText", "newContent"]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  return null;
}

function extractStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function extractStructuredDiff(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  const directDiff = extractStructuredDiffBlock(value);
  if (directDiff) {
    return directDiff;
  }

  if (!isRecord(value) || !Array.isArray(value.content)) {
    return null;
  }

  for (const item of value.content) {
    const diff = extractStructuredDiffBlock(item);
    if (diff) {
      return diff;
    }
  }

  return null;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function formatDiffRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

function formatDiffRangeFromSliceStart(startIndex: number, lineCount: number): string {
  if (lineCount === 0) {
    return `${startIndex},0`;
  }

  return `${startIndex + 1},${lineCount}`;
}

function countSharedPrefix(beforeLines: readonly string[], afterLines: readonly string[]): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length);
  let index = 0;
  while (index < maxLength && beforeLines[index] === afterLines[index]) {
    index += 1;
  }
  return index;
}

function countSharedSuffix(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  sharedPrefixCount: number,
): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length) - sharedPrefixCount;
  let offset = 0;
  while (
    offset < maxLength &&
    beforeLines[beforeLines.length - 1 - offset] === afterLines[afterLines.length - 1 - offset]
  ) {
    offset += 1;
  }
  return offset;
}

function appendLinesWithPrefix(
  patchLines: string[],
  prefix: " " | "+" | "-",
  lines: readonly string[],
): void {
  patchLines.push(...lines.map((line) => `${prefix}${line}`));
}

function collectUniqueLineMatches(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): LineMatch[] {
  const beforeOccurrences = new Map<string, { count: number; firstIndex: number }>();
  const afterOccurrences = new Map<string, { count: number; firstIndex: number }>();

  for (let index = 0; index < beforeLines.length; index += 1) {
    const line = beforeLines[index]!;
    const existing = beforeOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    beforeOccurrences.set(line, { count: 1, firstIndex: index });
  }

  for (let index = 0; index < afterLines.length; index += 1) {
    const line = afterLines[index]!;
    const existing = afterOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    afterOccurrences.set(line, { count: 1, firstIndex: index });
  }

  const matches: LineMatch[] = [];
  for (const [line, beforeOccurrence] of beforeOccurrences) {
    const afterOccurrence = afterOccurrences.get(line);
    if (beforeOccurrence.count !== 1 || afterOccurrence?.count !== 1) {
      continue;
    }
    matches.push({
      beforeIndex: beforeOccurrence.firstIndex,
      afterIndex: afterOccurrence.firstIndex,
    });
  }

  matches.sort((left, right) => left.beforeIndex - right.beforeIndex);
  return matches;
}

function findIncreasingAnchorMatches(matches: readonly LineMatch[]): LineMatch[] {
  if (matches.length === 0) {
    return [];
  }

  const predecessors = Array<number>(matches.length).fill(-1);
  const pileTops: number[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    let low = 0;
    let high = pileTops.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const currentTop = pileTops[middle]!;
      if (matches[currentTop]!.afterIndex < match.afterIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    if (low > 0) {
      predecessors[index] = pileTops[low - 1]!;
    }
    pileTops[low] = index;
  }

  const anchors: LineMatch[] = [];
  let currentIndex = pileTops[pileTops.length - 1]!;
  while (currentIndex >= 0) {
    anchors.push(matches[currentIndex]!);
    currentIndex = predecessors[currentIndex] ?? -1;
  }

  return anchors.reverse();
}

function appendDiffBodyWithLargeSegmentFallback(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  const anchors = findIncreasingAnchorMatches(collectUniqueLineMatches(beforeLines, afterLines));

  if (anchors.length === 0) {
    // Previously, large regions degraded into one block of “all removed, then all added.”
    // In cases like cli.ts with a few lines inserted at each end but far apart, this incorrectly rendered the entire unchanged region as large red/green blocks.
    // Prefer unique line anchors to split large regions into smaller chunks, then recurse through the normal diff to preserve real hunk boundaries where possible.
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  let previousBeforeIndex = 0;
  let previousAfterIndex = 0;

  for (const anchor of anchors) {
    appendDiffBody(
      patchLines,
      beforeLines.slice(previousBeforeIndex, anchor.beforeIndex),
      afterLines.slice(previousAfterIndex, anchor.afterIndex),
    );
    patchLines.push(` ${beforeLines[anchor.beforeIndex]!}`);
    previousBeforeIndex = anchor.beforeIndex + 1;
    previousAfterIndex = anchor.afterIndex + 1;
  }

  appendDiffBody(
    patchLines,
    beforeLines.slice(previousBeforeIndex),
    afterLines.slice(previousAfterIndex),
  );
}

function appendDiffBodyWithLcs(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  if (beforeLines.length === 0) {
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  if (afterLines.length === 0) {
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    return;
  }

  if (beforeLines.length * afterLines.length > MAX_DIFF_LCS_CELLS) {
    appendDiffBodyWithLargeSegmentFallback(patchLines, beforeLines, afterLines);
    return;
  }

  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lcs[beforeIndex + 1]![afterIndex + 1] ?? 0) + 1
          : Math.max(
              lcs[beforeIndex + 1]![afterIndex] ?? 0,
              lcs[beforeIndex]![afterIndex + 1] ?? 0,
            );
    }
  }

  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];

    if (beforeLine !== undefined && afterLine !== undefined && beforeLine === afterLine) {
      patchLines.push(` ${beforeLine}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLine === undefined && afterLine !== undefined) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (afterLine === undefined && beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
      continue;
    }

    const skipAfterScore = lcs[beforeIndex]![afterIndex + 1] ?? -1;
    const skipBeforeScore = lcs[beforeIndex + 1]![afterIndex] ?? -1;

    if (afterLine !== undefined && skipAfterScore >= skipBeforeScore) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
  }
}

function appendDiffBody(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  appendDiffBodyWithLcs(patchLines, beforeLines, afterLines);
}

export function buildUnifiedDiff(
  before: string,
  after: string,
  fileLabel: string,
  options?: {
    contextLines?: number;
  },
): string | null {
  const contextLines = options?.contextLines;
  const hasContextLimit =
    typeof contextLines === "number" && Number.isFinite(contextLines) && contextLines >= 0;
  const normalizedContextLines = hasContextLimit ? Math.max(0, Math.floor(contextLines)) : 0;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const sharedPrefixCount = countSharedPrefix(beforeLines, afterLines);
  const sharedSuffixCount = countSharedSuffix(beforeLines, afterLines, sharedPrefixCount);
  const beforeMiddle = beforeLines.slice(sharedPrefixCount, beforeLines.length - sharedSuffixCount);
  const afterMiddle = afterLines.slice(sharedPrefixCount, afterLines.length - sharedSuffixCount);
  const isCreatedFile = beforeLines.length === 0 && afterLines.length > 0;
  const isDeletedFile = beforeLines.length > 0 && afterLines.length === 0;

  const limitedPrefixCount = hasContextLimit
    ? Math.min(sharedPrefixCount, normalizedContextLines)
    : sharedPrefixCount;
  const limitedSuffixCount = hasContextLimit
    ? Math.min(sharedSuffixCount, normalizedContextLines)
    : sharedSuffixCount;

  const beforeSliceStart = sharedPrefixCount - limitedPrefixCount;
  const afterSliceStart = sharedPrefixCount - limitedPrefixCount;
  const beforeRangeLineCount = limitedPrefixCount + beforeMiddle.length + limitedSuffixCount;
  const afterRangeLineCount = limitedPrefixCount + afterMiddle.length + limitedSuffixCount;

  const patchLines = [
    // With only `---/+++` file headers, deleting one SQL comment line (`-- ...`) produces a `--- ...` body line.
    // @pierre/diffs splits unified diffs by that prefix, misclassifying the body as a second file and crashing FileDiff.
    // Add Git file boundaries so the parser splits only on `diff --git`; body lines no longer affect the file count.
    `diff --git a/${fileLabel} b/${fileLabel}`,
    // New files used to be emitted as --- a/file + @@ -0,0, which PatchDiff treated as
    // an ordinary rename/change diff; adding a large file could freeze the right pane during line mapping and highlighting.
    // Standard unified diff should use /dev/null for the missing side so the parser follows add/delete semantics.
    isCreatedFile ? "--- /dev/null" : `--- a/${fileLabel}`,
    isDeletedFile ? "+++ /dev/null" : `+++ b/${fileLabel}`,
    hasContextLimit
      ? `@@ -${formatDiffRangeFromSliceStart(beforeSliceStart, beforeRangeLineCount)} +${formatDiffRangeFromSliceStart(afterSliceStart, afterRangeLineCount)} @@`
      : `@@ -${formatDiffRange(beforeLines.length)} +${formatDiffRange(afterLines.length)} @@`,
  ];

  // In context mode, message summaries/Git pane need only the window “around the changes.”
  // Previously, even with only 3 context lines, the entire shared prefix/suffix was added to the patch before trimming;
  // expanding a large file (such as a 1,500+ line Dockerfile) caused substantial useless string concatenation on the main thread and froze the UI.
  // Truncate the shared prefix/suffix by context first, then pass it to trimPatchContext for final hunk normalization.
  patchLines.push(
    ...beforeLines
      .slice(sharedPrefixCount - limitedPrefixCount, sharedPrefixCount)
      .map((line) => ` ${line}`),
  );
  appendDiffBody(patchLines, beforeMiddle, afterMiddle);
  if (limitedSuffixCount > 0) {
    patchLines.push(
      ...beforeLines
        .slice(
          beforeLines.length - sharedSuffixCount,
          beforeLines.length - sharedSuffixCount + limitedSuffixCount,
        )
        .map((line) => ` ${line}`),
    );
  }

  const patch = patchLines.join("\n");
  if (hasContextLimit) {
    // Important behavior: the previous change built a patch from the full before/after snapshots.
    // Passing the entire patch to the previewer made cases like “one or two lines changed in a large file” fill the whole page,
    // making changes hard to locate at a glance. Normalize to a diff containing “changes + a fixed number of context lines”
    // so message summaries and Git panes prioritize locating changes instead of replaying entire files.
    return trimPatchContext(patch, normalizedContextLines);
  }

  return patch;
}
