// ============================================================
// Diagnostics normalization and classification (spec §6)
// ============================================================

import type { LspDiagnostic, LspDiagnosticSeverity } from "@zcode/contracts";
import { LSP_DIAGNOSTIC_SEVERITY } from "./constants.js";
import { toModelPosition } from "./position.js";

/** Raw LSP Diagnostic as received on the wire (0-based UTF-16 positions). */
export interface RawLspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export function normalizeRawDiagnostics(
  absolutePath: string,
  lines: readonly string[],
  raw: readonly RawLspDiagnostic[],
): LspDiagnostic[] {
  const result: LspDiagnostic[] = [];
  for (const item of raw) {
    if (!isRawDiagnostic(item)) continue;
    const start = toModelPosition(lines, item.range.start);
    const end = toModelPosition(lines, item.range.end);
    const diagnostic: LspDiagnostic = {
      path: absolutePath,
      line: start.line,
      character: start.character,
      endLine: end.line,
      endCharacter: end.character,
      severity: severityOf(item.severity),
      message: item.message,
    };
    if (item.code !== undefined) diagnostic.code = String(item.code);
    if (item.source !== undefined) diagnostic.source = item.source;
    result.push(diagnostic);
  }
  return result;
}

/** Errors and warnings only; info and hint are dropped from post-edit reports (spec §6). */
export function isReportableSeverity(severity: LspDiagnosticSeverity): boolean {
  return severity === "error" || severity === "warning";
}

export function severityRank(severity: LspDiagnosticSeverity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

/**
 * Identity used for baseline matching. The position is deliberately excluded: an edit above a
 * pre-existing error shifts its line, and that must not make it look new.
 */
export function diagnosticIdentity(diagnostic: LspDiagnostic): string {
  return [diagnostic.severity, diagnostic.code ?? "", diagnostic.message].join("\u0000");
}

/** Diagnostics present in `current` with no matching baseline entry (multiset match). */
export function diagnosticsNotInBaseline(
  current: readonly LspDiagnostic[],
  baseline: readonly LspDiagnostic[],
): LspDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const item of baseline) {
    const key = diagnosticIdentity(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added: LspDiagnostic[] = [];
  for (const item of current) {
    const key = diagnosticIdentity(item);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      added.push(item);
    }
  }
  return added;
}

/** Whether a diagnostic's line span overlaps the 1-based inclusive changed range. */
export function overlapsChangedRange(
  diagnostic: LspDiagnostic,
  range: { startLine: number; endLine: number },
): boolean {
  return diagnostic.line <= range.endLine && diagnostic.endLine >= range.startLine;
}

export function formatDiagnosticLocation(diagnostic: LspDiagnostic, displayPath: string): string {
  const tags = [diagnostic.source, diagnostic.code].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  const tail = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  return `${displayPath}:${diagnostic.line}:${diagnostic.character} ${diagnostic.severity} ${diagnostic.message}${tail}`;
}

function severityOf(value: number | undefined): LspDiagnosticSeverity {
  if (value === undefined) return "error";
  const mapped = LSP_DIAGNOSTIC_SEVERITY[value as keyof typeof LSP_DIAGNOSTIC_SEVERITY];
  return mapped ?? "error";
}

function isRawDiagnostic(value: unknown): value is RawLspDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RawLspDiagnostic>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.range?.start?.line === "number" &&
    typeof candidate.range?.start?.character === "number" &&
    typeof candidate.range?.end?.line === "number" &&
    typeof candidate.range?.end?.character === "number"
  );
}
