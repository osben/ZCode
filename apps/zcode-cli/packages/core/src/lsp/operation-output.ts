// ============================================================
// Model-facing projection of LSP results (spec §7)
// ============================================================
// Paths become workspace-relative when inside the workspace, positions become 1-based code
// point columns, each location gets a one-line preview, and item lists are capped.

import { isAbsolute, relative, sep } from "node:path";
import type { FileSystemPort, LspDiagnostic, LspOutput, TraceContext } from "@zcode/contracts";
import { LSP_MAX_RESULTS, LSP_PREVIEW_MAX_CHARS, type LspOperation } from "@zcode/contracts";
import { fromFileUri } from "./uri.js";
import {
  normalizeHover,
  normalizeLocations,
  normalizeSymbols,
  type RawLocationItem,
} from "./results.js";
import { splitLines, toModelPosition, codePointLength } from "./position.js";
import { isReportableSeverity } from "./diagnostics.js";

export type OperationStatus = LspOutput["status"];

/** Converts an absolute path to a workspace-relative, forward-slash path when it is inside the workspace. */
export function toModelPath(absolutePath: string, workspacePath: string): string {
  if (!isAbsolute(absolutePath)) return absolutePath;
  const relativePath = relative(workspacePath, absolutePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return absolutePath;
  }
  return relativePath.split(sep).join("/");
}

/** Reads source lines for position conversion, once per file per request. */
export class SourceLineReader {
  private readonly cache = new Map<string, Promise<string[] | undefined>>();

  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly options: { trace?: TraceContext; signal?: AbortSignal },
  ) {}

  linesFor(absolutePath: string): Promise<string[] | undefined> {
    let pending = this.cache.get(absolutePath);
    if (!pending) {
      pending = this.fileSystem
        .readTextFile(
          { path: absolutePath, trace: this.options.trace },
          { signal: this.options.signal },
        )
        .then((result) => splitLines(result.content))
        .catch(() => undefined);
      this.cache.set(absolutePath, pending);
    }
    return pending;
  }
}

export function previewOf(lineText: string | undefined): string {
  const trimmed = (lineText ?? "").trim();
  if (codePointLength(trimmed) <= LSP_PREVIEW_MAX_CHARS) return trimmed;
  return Array.from(trimmed).slice(0, LSP_PREVIEW_MAX_CHARS).join("");
}

export function capItems<T>(items: readonly T[]): {
  items: T[];
  truncated: boolean;
  total: number;
} {
  return {
    items: items.slice(0, LSP_MAX_RESULTS),
    truncated: items.length > LSP_MAX_RESULTS,
    total: items.length,
  };
}

interface ProjectionInput {
  operation: LspOperation;
  serverId: string;
  raw: unknown;
  documentUri: string;
  workspacePath: string;
  reader: SourceLineReader;
  status?: OperationStatus;
}

/** Projects a raw response for a non-diagnostics operation into the tool output. */
export async function projectOperationResult(input: ProjectionInput): Promise<LspOutput> {
  const base = {
    operation: input.operation,
    server: input.serverId,
    status: input.status ?? "ok",
  } as const;
  switch (input.operation) {
    case "goToDefinition":
    case "goToImplementation":
    case "findReferences": {
      const locations = await projectLocations(normalizeLocations(input.raw), input);
      const capped = capItems(locations);
      return { ...base, locations: capped.items, truncated: capped.truncated, total: capped.total };
    }
    case "hover": {
      const contents = normalizeHover(input.raw);
      return contents === undefined
        ? { ...base, truncated: false }
        : { ...base, hover: { contents }, truncated: false };
    }
    case "documentSymbol":
    case "workspaceSymbol": {
      const symbols = normalizeSymbols(input.raw, input.documentUri).map((symbol) => {
        const path = toModelPath(fromFileUri(symbol.uri), input.workspacePath);
        return {
          name: symbol.name,
          kind: symbol.kind,
          path,
          line: symbol.range.start.line + 1,
          ...(symbol.containerName === undefined ? {} : { containerName: symbol.containerName }),
        };
      });
      const capped = capItems(symbols);
      return { ...base, symbols: capped.items, truncated: capped.truncated, total: capped.total };
    }
    case "diagnostics":
      throw new Error("diagnostics are projected by the service, not by operation projection");
  }
}

/** Projects diagnostics for the model: errors and warnings are kept, info and hint are dropped. */
export function projectDiagnostics(
  serverId: string,
  diagnostics: readonly LspDiagnostic[],
  workspacePath: string,
  status: OperationStatus,
): LspOutput {
  const reportable = diagnostics.filter((item) => isReportableSeverity(item.severity));
  const capped = capItems(reportable);
  return {
    operation: "diagnostics",
    server: serverId,
    status,
    diagnostics: capped.items.map((item) => ({
      path: toModelPath(item.path, workspacePath),
      line: item.line,
      character: item.character,
      severity: item.severity,
      message: item.message,
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.source === undefined ? {} : { source: item.source }),
    })),
    truncated: capped.truncated,
    total: capped.total,
  };
}

async function projectLocations(
  items: readonly RawLocationItem[],
  input: ProjectionInput,
): Promise<LspOutput["locations"] & object> {
  const result: NonNullable<LspOutput["locations"]> = [];
  for (const item of items) {
    const absolutePath = fromFileUri(item.uri);
    const lines = await input.reader.linesFor(absolutePath);
    const start = toModelPosition(lines ?? [], item.range.start);
    const end = toModelPosition(lines ?? [], item.range.end);
    const lineText = lines?.[item.range.start.line];
    result.push({
      path: toModelPath(absolutePath, input.workspacePath),
      line: start.line,
      character: lines ? start.character : item.range.start.character + 1,
      endLine: end.line,
      endCharacter: lines ? end.character : item.range.end.character + 1,
      preview: previewOf(lineText),
    });
  }
  return result;
}
