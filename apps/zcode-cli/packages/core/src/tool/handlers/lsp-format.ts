// ============================================================
// Model-facing text for LSP tool results (spec §7)
// ============================================================

import type { LspOutput } from "@zcode/contracts";

const NO_RESULTS_TEXT = "No results";
const PENDING_DIAGNOSTICS_TEXT =
  "Diagnostics pending: the language server has not reported fresh results for this file yet. This is not the same as no errors.";
const PENDING_TEXT =
  "Result pending: the language server has not answered yet. Retry shortly, or use Grep meanwhile.";
const TRUNCATION_NOTE = "(Results are truncated. Narrow the query to see the rest.)";

export function formatLspModelContent(output: unknown): string {
  const result = output as LspOutput;
  const lines: string[] = [];

  if (result.locations !== undefined) {
    for (const location of result.locations) {
      lines.push(
        `${location.path}:${location.line}:${location.character}  ${location.preview}`.trimEnd(),
      );
    }
  }
  if (result.symbols !== undefined) {
    for (const symbol of result.symbols) {
      const container = symbol.containerName === undefined ? "" : ` in ${symbol.containerName}`;
      lines.push(`${symbol.kind} ${symbol.name}${container}  ${symbol.path}:${symbol.line}`);
    }
  }
  if (result.hover !== undefined) {
    lines.push(result.hover.contents);
  }
  if (result.diagnostics !== undefined) {
    for (const item of result.diagnostics) {
      const tags = [item.source, item.code].filter((value): value is string => value !== undefined);
      const tail = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
      lines.push(
        `${item.path}:${item.line}:${item.character} ${item.severity} ${item.message}${tail}`,
      );
    }
  }

  if (result.status === "pending") {
    lines.push(result.operation === "diagnostics" ? PENDING_DIAGNOSTICS_TEXT : PENDING_TEXT);
  }
  if (lines.length === 0) {
    return result.operation === "diagnostics" ? "No diagnostics reported" : NO_RESULTS_TEXT;
  }
  if (result.truncated) lines.push(TRUNCATION_NOTE);
  return lines.join("\n");
}
