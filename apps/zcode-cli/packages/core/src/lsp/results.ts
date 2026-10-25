// ============================================================
// Normalization of raw LSP results (spec §7)
// ============================================================
// These functions only reshape wire data. Path relativization and 1-based position
// conversion happen in output.ts, which reads the target files through FileSystemPort.

import { LSP_HOVER_MAX_CHARS, LSP_SYMBOL_KIND_NAMES } from "./constants.js";

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface RawLocationItem {
  uri: string;
  range: LspRange;
}

export interface RawSymbolItem {
  name: string;
  kind: string;
  containerName?: string;
  uri: string;
  range: LspRange;
}

const HOVER_SEPARATOR = "\n\n";
const TRUNCATION_MARKER = "\n...(truncated)";

/** Definition, implementation and references: Location | Location[] | LocationLink[] | null. */
export function normalizeLocations(raw: unknown): RawLocationItem[] {
  const items = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const result: RawLocationItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.targetUri === "string") {
      const range = (item.targetSelectionRange ?? item.targetRange) as LspRange | undefined;
      if (isRange(range)) result.push({ uri: item.targetUri, range });
      continue;
    }
    if (typeof item.uri === "string" && isRange(item.range)) {
      result.push({ uri: item.uri, range: item.range });
    }
  }
  return result;
}

/** Hover: MarkupContent | MarkedString | MarkedString[] to plain text, truncated. */
export function normalizeHover(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const text = hoverContentsToText(raw.contents).trim();
  if (text.length === 0) return undefined;
  return truncateHover(text);
}

/** DocumentSymbol (tree, flattened with container names) or SymbolInformation (flat). */
export function normalizeSymbols(raw: unknown, documentUri: string): RawSymbolItem[] {
  if (!Array.isArray(raw)) return [];
  const result: RawSymbolItem[] = [];
  for (const item of raw) collectSymbol(item, documentUri, undefined, result);
  return result;
}

export function symbolKindName(kind: unknown): string {
  if (typeof kind !== "number") return "unknown";
  return LSP_SYMBOL_KIND_NAMES[kind] ?? "unknown";
}

function collectSymbol(
  item: unknown,
  documentUri: string,
  containerName: string | undefined,
  out: RawSymbolItem[],
): void {
  if (!isRecord(item) || typeof item.name !== "string") return;
  const kind = symbolKindName(item.kind);
  if (isRange(item.selectionRange)) {
    // DocumentSymbol: a tree whose children belong to this node.
    out.push(
      withContainer(
        { name: item.name, kind, uri: documentUri, range: item.selectionRange },
        containerName,
      ),
    );
    if (Array.isArray(item.children)) {
      for (const child of item.children) collectSymbol(child, documentUri, item.name, out);
    }
    return;
  }
  const location = isRecord(item.location) ? item.location : undefined;
  if (location && typeof location.uri === "string" && isRange(location.range)) {
    out.push(
      withContainer(
        {
          name: item.name,
          kind,
          uri: location.uri,
          range: location.range,
        },
        typeof item.containerName === "string" ? item.containerName : containerName,
      ),
    );
  }
}

function withContainer(item: RawSymbolItem, containerName: string | undefined): RawSymbolItem {
  return containerName === undefined ? item : { ...item, containerName };
}

function hoverContentsToText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => hoverContentsToText(entry))
      .filter((text) => text.length > 0)
      .join(HOVER_SEPARATOR);
  }
  if (isRecord(contents) && typeof contents.value === "string") {
    return contents.value;
  }
  return "";
}

function truncateHover(text: string): string {
  if (text.length <= LSP_HOVER_MAX_CHARS) return text;
  return `${text.slice(0, LSP_HOVER_MAX_CHARS)}${TRUNCATION_MARKER}`;
}

/**
 * Changed range for a Write that replaces existing content: the lines between the common
 * prefix and common suffix of the old and new text (1-based, inclusive, in the new content).
 */
export function changedRangeBetweenLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): { startLine: number; endLine: number } {
  const limit = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < limit && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const startLine = prefix + 1;
  const endLine = newLines.length - suffix;
  if (endLine < startLine) {
    // Pure deletion: mark the position where lines were removed.
    return { startLine: Math.max(1, startLine), endLine: Math.max(1, startLine) };
  }
  return { startLine, endLine };
}

/** Changed range from structuredPatch hunks (new-file side), unioned across hunks. */
export function changedRangeFromHunks(
  hunks: readonly { newStart: number; newLines: number }[],
): { startLine: number; endLine: number } | undefined {
  let startLine: number | undefined;
  let endLine: number | undefined;
  for (const hunk of hunks) {
    const start = Math.max(1, hunk.newStart);
    const end = hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : start;
    startLine = startLine === undefined ? start : Math.min(startLine, start);
    endLine = endLine === undefined ? end : Math.max(endLine, end);
  }
  if (startLine === undefined || endLine === undefined) return undefined;
  return { startLine, endLine };
}

function isRange(value: unknown): value is LspRange {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return false;
  return (
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
