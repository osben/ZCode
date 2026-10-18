// ============================================================
// Position conversion between model-facing and LSP coordinates (spec §7)
// ============================================================
// Model-facing: 1-based line, 1-based column counted in code points.
// LSP (default encoding): 0-based line, 0-based column counted in UTF-16 code units.
// Lines are split on LF and a trailing CR is removed, so CRLF files resolve identically.

import { LspError } from "@zcode/contracts";
import { LSP_IDENTIFIER_CHAR_SOURCE } from "./constants.js";

export function splitLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Code point count of a string (surrogate pairs count once). */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * Converts a 1-based code point column into a UTF-16 index within `lineText`.
 * Columns are valid in [1, codePoints + 1]; the end-of-line column is allowed.
 */
export function codePointColumnToUtf16(lineText: string, column: number): number {
  if (!Number.isInteger(column) || column < 1) {
    throw invalidPosition(`Column must be a positive integer, got ${column}`);
  }
  let utf16Index = 0;
  let current = 1;
  for (const char of lineText) {
    if (current === column) return utf16Index;
    utf16Index += char.length;
    current += 1;
  }
  if (current === column) return utf16Index;
  throw invalidPosition(`Column ${column} is past the end of the line`);
}

/** Converts a UTF-16 index within `lineText` into a 1-based code point column. */
export function utf16ToCodePointColumn(lineText: string, utf16Index: number): number {
  const safeIndex = Math.min(Math.max(0, utf16Index), lineText.length);
  return codePointLength(lineText.slice(0, safeIndex)) + 1;
}

/**
 * First whole-word occurrence of `symbol` on the line, as a 1-based code point column.
 * "Whole word" means neither neighbour is an identifier character, so `use` does not match `user`.
 */
export function findSymbolColumn(lineText: string, symbol: string): number | undefined {
  if (symbol.length === 0) return undefined;
  const pattern = new RegExp(
    `(?<!${LSP_IDENTIFIER_CHAR_SOURCE})${escapeRegExp(symbol)}(?!${LSP_IDENTIFIER_CHAR_SOURCE})`,
    "u",
  );
  const match = pattern.exec(lineText);
  if (!match) return undefined;
  return utf16ToCodePointColumn(lineText, match.index);
}

export interface ModelPosition {
  line: number;
  character?: number;
  symbol?: string;
}

export interface LspZeroBasedPosition {
  line: number;
  character: number;
}

/**
 * Resolves a model position against the actual line text. `symbol` takes precedence over
 * `character` (spec §7: models miscount columns). Throws LspError with a stable code otherwise.
 */
export function resolveModelPosition(
  lines: readonly string[],
  position: ModelPosition,
): LspZeroBasedPosition {
  if (!Number.isInteger(position.line) || position.line < 1 || position.line > lines.length) {
    throw invalidPosition(`Line ${position.line} is outside the file (1-${lines.length})`);
  }
  const lineIndex = position.line - 1;
  const lineText = lines[lineIndex] ?? "";
  let column: number;
  if (position.symbol !== undefined) {
    const found = findSymbolColumn(lineText, position.symbol);
    if (found === undefined) {
      throw new LspError(
        "lsp_symbol_not_found_on_line",
        `Symbol "${position.symbol}" does not occur as a whole word on line ${position.line}`,
      );
    }
    column = found;
  } else if (position.character !== undefined) {
    column = position.character;
  } else {
    throw invalidPosition("Give either character or symbol");
  }
  return { line: lineIndex, character: codePointColumnToUtf16(lineText, column) };
}

/** Converts a 0-based LSP position into the model-facing 1-based form. */
export function toModelPosition(
  lines: readonly string[],
  position: LspZeroBasedPosition,
): { line: number; character: number } {
  const lineText = lines[position.line] ?? "";
  return {
    line: position.line + 1,
    character: utf16ToCodePointColumn(lineText, position.character),
  };
}

function invalidPosition(message: string): LspError {
  return new LspError("lsp_invalid_position", message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
