// ============================================================
// LSP core constants (spec: docs/design/v2/tool/19-lsp.md §5-§7)
// ============================================================

/** Open documents per server before the least recently used one is closed with didClose. */
export const LSP_MAX_OPEN_DOCUMENTS = 50;

/** Post-edit diagnostics: maximum issues listed in one attachment. */
export const LSP_EDIT_DIAGNOSTICS_MAX = 20;

/** Post-edit diagnostics: bound from the last mutation to the model request (spec §6). */
export const LSP_EDIT_DIAGNOSTICS_WAIT_MS = 2_000;

/** Attachment rounds a still-pending file is carried before it is dropped. */
export const LSP_EDIT_DIAGNOSTICS_MAX_CARRY_ROUNDS = 3;

/** Hover text longer than this (in characters) is truncated. */
export const LSP_HOVER_MAX_CHARS = 2_000;

/** Freshness wait for the `diagnostics` operation before it reports `pending`. */
export const LSP_DIAGNOSTICS_QUERY_WAIT_MS = LSP_EDIT_DIAGNOSTICS_WAIT_MS;

export const LSP_DIAGNOSTICS_ATTACHMENT_SOURCE = "diagnostics";
export const LSP_EDIT_DIAGNOSTICS_LOG_EVENT = "core.lsp.edit_diagnostics";
export const LSP_LOG_MODULE = "core.lsp";

/** Identifier character class used for whole-word symbol lookup on a line. */
export const LSP_IDENTIFIER_CHAR_SOURCE = "[\\p{L}\\p{N}_$]";

export const LSP_METHODS = {
  initialized: "initialized",
  didOpen: "textDocument/didOpen",
  didChange: "textDocument/didChange",
  didClose: "textDocument/didClose",
  didChangeWatchedFiles: "workspace/didChangeWatchedFiles",
  publishDiagnostics: "textDocument/publishDiagnostics",
  pullDiagnostics: "textDocument/diagnostic",
  definition: "textDocument/definition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
  workspaceSymbol: "workspace/symbol",
} as const;

/** LSP FileChangeType values. */
export const LSP_FILE_CHANGE_TYPE = {
  created: 1,
  changed: 2,
  deleted: 3,
} as const;

/** LSP DiagnosticSeverity values (1 error, 2 warning, 3 information, 4 hint). */
export const LSP_DIAGNOSTIC_SEVERITY = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
} as const;

/** LSP SymbolKind numeric values mapped to readable names (spec §7 DocumentSymbol flattening). */
export const LSP_SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enumMember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeParameter",
};
