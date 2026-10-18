// ============================================================
// LSP operation table: method, required server capability, request params (spec §7)
// ============================================================

import type { LspOperation } from "@zcode/contracts";
import { LSP_METHODS } from "./constants.js";

export interface OperationRequest {
  method: string;
  params: unknown;
}

/** Server capability key that must be truthy for the operation; undefined means no request (diagnostics). */
export const OPERATION_CAPABILITY: Readonly<Record<LspOperation, string | undefined>> = {
  goToDefinition: "definitionProvider",
  goToImplementation: "implementationProvider",
  findReferences: "referencesProvider",
  hover: "hoverProvider",
  documentSymbol: "documentSymbolProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  diagnostics: undefined,
};

export interface PositionedOperationInput {
  operation: LspOperation;
  uri: string;
  position: { line: number; character: number };
  includeDeclaration?: boolean;
  query?: string;
}

export function buildOperationRequest(
  input: PositionedOperationInput,
): OperationRequest | undefined {
  const textDocument = { uri: input.uri };
  const position = input.position;
  switch (input.operation) {
    case "goToDefinition":
      return { method: LSP_METHODS.definition, params: { textDocument, position } };
    case "goToImplementation":
      return { method: LSP_METHODS.implementation, params: { textDocument, position } };
    case "findReferences":
      return {
        method: LSP_METHODS.references,
        params: {
          textDocument,
          position,
          context: { includeDeclaration: input.includeDeclaration ?? false },
        },
      };
    case "hover":
      return { method: LSP_METHODS.hover, params: { textDocument, position } };
    case "documentSymbol":
      return { method: LSP_METHODS.documentSymbol, params: { textDocument } };
    case "workspaceSymbol":
      return { method: LSP_METHODS.workspaceSymbol, params: { query: input.query ?? "" } };
    case "diagnostics":
      return undefined;
  }
}

/** Operations whose input needs a position in the file (line plus character or symbol). */
export function isPositionalOperation(operation: LspOperation): boolean {
  return (
    operation === "goToDefinition" ||
    operation === "goToImplementation" ||
    operation === "findReferences" ||
    operation === "hover"
  );
}
