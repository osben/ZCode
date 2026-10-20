import { getFiletypeFromFileName, getSingularPatch, parsePatchFiles } from "@pierre/diffs";

const MAX_PATCH_DIFF_SAFE_LINE_COUNT = 1_200;
const MAX_PATCH_DIFF_SAFE_CHAR_COUNT = 180_000;
const MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER = 1_200;
const MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES = 800;
// Do not concatenate display copy here, or the library layer would hard-code English in the UI and break localization.
// Use an internal marker token instead; the component layer renders the actual copy through intl.
const FALLBACK_TRUNCATED_MARKER_PREFIX = "\\ __ZCODE_DIFF_TRUNCATED__:";
const FALLBACK_TRUNCATED_MARKER_REGEX = /^\\ __ZCODE_DIFF_TRUNCATED__:(\d+)$/;
const PACKAGE_MANAGER_LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES = new Set(["zsh"]);
// Gradle scripts are identified as ordinary text by @pierre/diffs.
// If some entry points or workers are unavailable, these patches may still go through PatchDiff and synchronously block the main thread.
// Fall back to a lightweight <pre> by file extension to keep the whole screen interactive after clicking a file chip.
const PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES = [".gradle", ".gradle.kts"];

function buildTruncatedMarkerLine(omittedLineCount: number): string {
  return `${FALLBACK_TRUNCATED_MARKER_PREFIX}${omittedLineCount}`;
}

export function countPatchFileDiffs(patch: string): number {
  const lines = patch.split(/\r?\n/);
  const gitDiffHeaderCount = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (gitDiffHeaderCount > 0) {
    return gitDiffHeaderCount;
  }

  const parseHunkRange = (line: string): { oldLines: number; newLines: number } | null => {
    const match = line.match(/^@@\s-\d+(?:,(\d+))?\s\+\d+(?:,(\d+))?\s@@/);
    if (!match) {
      return null;
    }
    return {
      oldLines: Number(match[1] ?? "1"),
      newLines: Number(match[2] ?? "1"),
    };
  };

  const isFileHeaderPair = (index: number): boolean => {
    return (
      (lines[index]?.startsWith("--- ") ?? false) && (lines[index + 1]?.startsWith("+++ ") ?? false)
    );
  };

  const consumeHunkBody = (start: number, oldLines: number, newLines: number): number | null => {
    let cursor = start;
    let remainingOld = oldLines;
    let remainingNew = newLines;

    while (remainingOld > 0 || remainingNew > 0) {
      const line = lines[cursor];
      if (line === undefined) {
        return null;
      }

      // In multi-file patches without a `diff --git` prefix, the next file header is `--- a/x` followed by `+++ b/x`.
      // These lines start with `-`/`+`; if consumed as current-hunk deletion/addition lines, an oversized hunk count
      // (a common LLM off-by-one) may use up the extra allowance on the next file header. The following `@@` is then
      // treated as another hunk in the same file, miscounting a multi-file patch as a single-file patch.
      // Probe for the complete `---`/`+++` header pair while consuming the body; end the current hunk as soon as it appears
      // and return control to the outer loop to recognize the next file instead of folding its header into the body.
      if (isFileHeaderPair(cursor)) {
        return cursor;
      }

      if (line.startsWith("\\ ")) {
        cursor += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        remainingOld -= 1;
        remainingNew -= 1;
      } else if (line.startsWith("-")) {
        remainingOld -= 1;
      } else if (line.startsWith("+")) {
        remainingNew -= 1;
      } else {
        return null;
      }

      if (remainingOld < 0 || remainingNew < 0) {
        return null;
      }
      cursor += 1;
    }

    while (lines[cursor]?.startsWith("\\ ")) {
      cursor += 1;
    }
    return cursor;
  };

  let diffCount = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const oldHeader = lines[cursor];
    const newHeader = lines[cursor + 1];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) {
      cursor += 1;
      continue;
    }

    let hunkCursor = cursor + 2;
    let hasHunk = false;
    let sawHunkHeader = false;

    while (hunkCursor < lines.length) {
      const hunkRange = parseHunkRange(lines[hunkCursor] ?? "");
      if (!hunkRange) {
        break;
      }
      sawHunkHeader = true;

      const nextCursor = consumeHunkBody(hunkCursor + 1, hunkRange.oldLines, hunkRange.newLines);
      if (nextCursor === null) {
        break;
      }

      hasHunk = true;
      hunkCursor = nextCursor;
    }

    if (!hasHunk && !sawHunkHeader) {
      cursor += 1;
      continue;
    }

    // Hunk bodies can contain real text lines beginning with `---`/`+++`, so do not count file headers by prefix alone.
    // But if a body is truncated after a hunk header, conservatively count one file diff.
    // Consume the body using the line counts declared in the hunk header, recognize `---`/`+++` pairs as file headers
    // only when a hunk parsed successfully, and count conservatively on truncation to avoid misclassifying a multi-file patch as one file.
    diffCount += 1;
    cursor = hasHunk ? hunkCursor : cursor + 2;
  }

  return diffCount;
}

export function parseTruncatedMarkerOmittedLineCount(line: string): number | null {
  const markerMatch = FALLBACK_TRUNCATED_MARKER_REGEX.exec(line);
  if (!markerMatch) {
    return null;
  }

  const omittedLineCount = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(omittedLineCount) || omittedLineCount <= 0) {
    return null;
  }

  return omittedLineCount;
}

export function getPatchPreviewLineContent(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return line.slice(1);
  }

  return line;
}

function isPatchHunkHeaderLine(line: string): boolean {
  return line === "@@" || line.startsWith("@@ ");
}

function getMaxHunkLineNumber(lines: readonly string[]): number {
  let maxLineNumber = 0;

  for (const line of lines) {
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }

    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const oldEnd = oldStart + Math.max(0, Number.isNaN(oldCount) ? 1 : oldCount) - 1;
    const newEnd = newStart + Math.max(0, Number.isNaN(newCount) ? 1 : newCount) - 1;

    maxLineNumber = Math.max(maxLineNumber, oldEnd, newEnd);
  }

  return maxLineNumber;
}

function limitPlainTextPreviewLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES) {
    return [...lines];
  }

  const keepCount = MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES - 1;
  const headCount = Math.ceil(keepCount / 2);
  const tailCount = keepCount - headCount;
  const omittedCount = lines.length - keepCount;

  return [
    ...lines.slice(0, headCount),
    buildTruncatedMarkerLine(omittedCount),
    ...lines.slice(lines.length - tailCount),
  ];
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    // Standard unified-diff headers may append a tab-separated timestamp after the path.
    // Strip the timestamp first, or suffix-based fallback rules for `.gradle` can be bypassed by `test.gradle\t...`.
    const fileName = line.slice(4).trim().split("\t", 1)[0]?.trim() ?? "";
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}

function normalizePatchFileName(fileName: string): string {
  return fileName.replace(/^([ab])\//, "");
}

function isPackageManagerLockfile(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  return PACKAGE_MANAGER_LOCKFILE_NAMES.has(
    normalizePatchFileName(fileName).split("/").at(-1)?.toLocaleLowerCase() ?? "",
  );
}

function shouldForcePlainTextPatchPreviewByFileName(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  const normalizedFileName = normalizePatchFileName(fileName).toLocaleLowerCase();

  return PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES.some((suffix) =>
    normalizedFileName.endsWith(suffix),
  );
}

function shouldForcePlainTextPatchPreview(fileName: string | null): boolean {
  if (isPackageManagerLockfile(fileName)) {
    return true;
  }

  if (shouldForcePlainTextPatchPreviewByFileName(fileName)) {
    return true;
  }

  if (!fileName) {
    return false;
  }

  return PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES.has(getFiletypeFromFileName(fileName));
}

function collectPatchMetadataPreviewLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return false;
    }

    return (
      !line.startsWith("diff --git ") &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ ")
    );
  });
}

function collectPlainTextPreviewLines(lines: readonly string[]): string[] {
  const previewLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk) {
      if (isPatchHunkHeaderLine(line)) {
        inHunk = true;
      }
      continue;
    }

    // Filtering directly by `+++`/`---`/`@@` prefixes previously removed real `++ `/`-- ` lines from the body.
    // Skip only the hunk header; once inside a hunk, preserve all following content as-is.
    if (isPatchHunkHeaderLine(line)) {
      continue;
    }

    previewLines.push(line);
  }

  if (inHunk || previewLines.length > 0) {
    return previewLines;
  }

  // Git patches such as rename-only/mode-only have no @@ hunk but still contain changes users need to see.
  // They were previously sent to PatchDiff, where some files rendered blank in packaged builds; preserve the metadata in the lightweight fallback.
  return collectPatchMetadataPreviewLines(lines);
}

function normalizePlainTextPreviewLines(lines: readonly string[]): string[] {
  const normalizedLines = limitPlainTextPreviewLines(lines);

  // The fallback preserves readability and interaction; it does not need to expose protocol headers such as `---/+++ / @@`.
  while (normalizedLines.length > 0 && normalizedLines.at(-1) === "") {
    normalizedLines.pop();
  }

  return normalizedLines.length > 0 ? normalizedLines : [""];
}

export function getPlainTextPatchPreviewLines(patch: string): string[] {
  return normalizePlainTextPreviewLines(getPlainTextPatchContentLines(patch));
}

export function getPlainTextPatchContentLines(patch: string): string[] {
  return collectPlainTextPreviewLines(patch.split(/\r?\n/));
}

export function getPlainTextPatchFallbackLines(patch: string): string[] | null {
  const lines = patch.split(/\r?\n/);
  const patchFileDiffCount = countPatchFileDiffs(patch);
  const hasMultipleFileDiffs = patchFileDiffCount > 1;
  const hasNoFileDiff = patchFileDiffCount === 0;
  const isCreatedFile = lines.some((line) => line === "--- /dev/null");
  const isDeletedFile = lines.some((line) => line === "+++ /dev/null");
  const maxHunkLineNumber = getMaxHunkLineNumber(lines);
  const isOversizedPatch =
    lines.length > MAX_PATCH_DIFF_SAFE_LINE_COUNT || patch.length > MAX_PATCH_DIFF_SAFE_CHAR_COUNT;
  const isDeepHunkLinePatch = maxHunkLineNumber > MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER;
  const patchFileName = getPatchContentFileName(lines);
  const shouldForcePlainTextPreview = shouldForcePlainTextPatchPreview(patchFileName);

  const metadataOnlyPreviewLines = collectPatchMetadataPreviewLines(lines);
  const isMetadataOnlyPatch =
    metadataOnlyPreviewLines.length > 0 && !lines.some(isPatchHunkHeaderLine);

  if (
    !hasNoFileDiff &&
    !hasMultipleFileDiffs &&
    !isCreatedFile &&
    !isDeletedFile &&
    !isOversizedPatch &&
    !isDeepHunkLinePatch &&
    !isMetadataOnlyPatch &&
    !shouldForcePlainTextPreview
  ) {
    try {
      // Our counter may identify this as logically single-file by hunk line counts, while PatchDiff's actual parser
      // can misread a deleted SQL comment (body line like `--- ...`) as a second file. The final safety decision must use
      // the parser from @pierre/diffs, which is responsible for rendering; otherwise two parsing semantics can let input slip through.
      // Do not call getSingularPatch here: on expected multi-file results it first console.error(files) and then throws,
      // leaking user code into the console. Parse with throwOnError and inspect the count ourselves so normal fallback has no log side effects.
      const parsedPatches = parsePatchFiles(patch, undefined, true);
      if (parsedPatches.length === 1 && parsedPatches[0]?.files.length === 1) {
        return null;
      }
    } catch {
      // Parse failures and multiple files are both expected fallback conditions; return a lightweight text preview below.
    }
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (isMetadataOnlyPatch) {
    return normalizePlainTextPreviewLines(metadataOnlyPreviewLines);
  }

  if (hasNoFileDiff) {
    // Summaries/tool replays may contain apply_patch fragments or bare hunks.
    // These inputs have no standard file-diff header, so PatchDiff synchronously throws
    // “Provided patch must contain exactly 1 file diff”; fall back directly.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (shouldForcePlainTextPreview) {
    // Syntax-highlighting worker handling of lockfiles/shell scripts through PatchDiff is unstable in production builds;
    // diffs have loaded but expanded content failed. Always use the lightweight text preview for these files so the content remains visible.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if ((isCreatedFile || isDeletedFile) && !isOversizedPatch && !isDeepHunkLinePatch) {
    // When the file-change panel expands a non-plain-text added/deleted file, PatchDiff may render only an empty shell,
    // leaving users with no content. Added/deleted files are full-file snapshots anyway, so skip extension-based routing
    // and use the lightweight text fallback to keep expanded content readable.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (!hasMultipleFileDiffs && !isOversizedPatch && !isDeepHunkLinePatch) {
    try {
      const resolvedPatchFileName = patchFileName ?? getSingularPatch(patch).name;
      const patchFileType = getFiletypeFromFileName(resolvedPatchFileName);

      // Even a small patch for an added/deleted plain-text file can make `@pierre/diffs` block the main thread during synchronous rendering,
      // leaving the whole UI unresponsive. Also, if a deleted file's body begins with `--- `, `getSingularPatch()` may split it as a new file header.
      // Prefer extracting the path from the first real file header, then fall back to the library parser, so body text cannot affect file-type detection.
      // Unknown extensions fall back to text, so gate by the parsed file type instead of matching a fixed set of extensions.
      if (patchFileType !== "text") {
        return null;
      }
    } catch {
      // Single-file count detection filters only obviously malformed input; before passing it to @pierre/diffs, still trust
      // the parser result. If parsing fails, the library cannot confirm there is exactly one file diff, and rendering could trigger the error boundary.
      return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
    }
  }

  // PatchDiff from `@pierre/diffs` can render only single-file patches.
  // Some toolchains concatenate multiple files' unified diffs into one field; passing that through makes rendering throw
  // “Provided patch must contain exactly 1 file diff” and triggers the page-wide error boundary.
  // Fall back to a plain-text preview here as for large files/deep line numbers, preserving chat usability.
  // Expanding a very large patch (for example, a thousand-line Dockerfile) triggers synchronous PatchDiff parsing
  // and can block the UI main thread, freezing the whole page after clicking “Expand diff.”
  // Some large files change only one line at a deep hunk position (such as 1500+), which can also make PatchDiff stall.
  // Always use lightweight plain-text rendering for these cases to keep interactions usable.

  return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
}
