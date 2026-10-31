import { Lexer } from "marked";

/** Index file name in the memory directory; the context prefix injects it, and compaction restore excludes it by this name. */
export const MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const MEMORY_INDEX_LINE_LIMIT = 200;
const MEMORY_INDEX_CHARACTER_LIMIT = 25_000;
// Newest index entries are appended at the end, so over the limits the kept budget is biased
// toward the tail instead of silently dropping them.
const ELISION_HEAD_SHARE = 0.3;
// The completed elision must fit the line cap as a whole: the marker line and the two blank
// separator lines around it are part of the kept output.
const ELISION_RESERVED_LINES = 3;
const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

export function formatProjectMemoryIndexContent(content: string): string {
  const withoutFrontmatter = content.replace(LEADING_FRONTMATTER_PATTERN, "");
  return formatMemoryIndexContent(stripTopLevelMarkdownHtmlComments(withoutFrontmatter));
}

export function formatMemoryIndexContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > MEMORY_INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > MEMORY_INDEX_CHARACTER_LIMIT;
  if (!lineTruncated && !characterTruncated) return trimmed;

  const kept = elideIndexMiddle(lines, characterTruncated);
  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(MEMORY_INDEX_CHARACTER_LIMIT)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${MEMORY_INDEX_LINE_LIMIT})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`;

  return `${kept}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

function elideIndexMiddle(lines: string[], characterTruncated: boolean): string {
  const marker = elisionMarker(characterTruncated);
  // Reserve line slots for the marker and its two blank separator lines so the completed
  // elision satisfies the line cap in both branches, not just the character budget.
  const maxKeptLines = MEMORY_INDEX_LINE_LIMIT - ELISION_RESERVED_LINES;
  const headLineLimit = Math.floor(maxKeptLines * ELISION_HEAD_SHARE);
  const tailLineLimit = maxKeptLines - headLineLimit;
  if (!characterTruncated) {
    return `${lines.slice(0, headLineLimit).join("\n")}\n\n${marker}\n\n${lines.slice(-tailLineLimit).join("\n")}`;
  }

  // Reserve the marker plus its two "\n\n" joins so the kept text stays within the cap.
  const budget = MEMORY_INDEX_CHARACTER_LIMIT - marker.length - 4;
  const headBudget = Math.floor(budget * ELISION_HEAD_SHARE);
  const head = takeHeadLines(lines, headBudget, headLineLimit);
  const tail = takeTailLines(lines, budget - head.length, tailLineLimit);
  return `${head}\n\n${marker}\n\n${tail}`;
}

function elisionMarker(characterTruncated: boolean): string {
  return characterTruncated
    ? `…[MEMORY.md is over the ${formatBytes(MEMORY_INDEX_CHARACTER_LIMIT)} cap; its middle is omitted]…`
    : `…[MEMORY.md is over the ${MEMORY_INDEX_LINE_LIMIT}-line cap; its middle is omitted]…`;
}

function takeHeadLines(lines: readonly string[], maxChars: number, maxLines: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const nextLength = length + line.length + (kept.length > 0 ? 1 : 0);
    if (nextLength > maxChars) {
      // An entry longer than the whole head budget would otherwise drop the head side entirely;
      // keep a bounded leading slice of that single line instead.
      if (kept.length === 0 && maxChars > 0) return line.slice(0, maxChars);
      break;
    }
    kept.push(line);
    length = nextLength;
  }
  return kept.join("\n");
}

function takeTailLines(lines: readonly string[], maxChars: number, maxLines: number): string {
  const kept: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxLines) break;
    const line = lines[index]!;
    const nextLength = length + line.length + (kept.length > 0 ? 1 : 0);
    if (nextLength > maxChars) {
      if (kept.length === 0 && maxChars > 0) return line.slice(-maxChars);
      break;
    }
    kept.unshift(line);
    length = nextLength;
  }
  return kept.join("\n");
}

function formatBytes(value: number): string {
  const kilobytes = value / 1024;
  if (kilobytes < 1) return `${value} bytes`;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, "")}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, "")}MB`;
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, "")}GB`;
}

function stripTopLevelMarkdownHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;

  let result = "";
  for (const token of new Lexer({ gfm: false }).lex(content)) {
    if (token.type === "html") {
      const trimmedToken = token.raw.trimStart();
      if (trimmedToken.startsWith("<!--") && trimmedToken.includes("-->")) {
        const withoutComments = token.raw.replace(HTML_COMMENT_PATTERN, "");
        // Remove only top-level HTML comment tokens recognized by the Markdown lexer;
        // comments inside list, blockquote, paragraph, and code tokens must remain provider-visible.
        if (withoutComments.trim().length > 0) result += withoutComments;
        continue;
      }
    }
    result += token.raw;
  }
  return result;
}
