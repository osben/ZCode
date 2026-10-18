// ============================================================
// LSP core public entry (spec docs/design/v2/tool/19-lsp.md)
// ============================================================

export {
  LspService,
  createLspDocumentSync,
  type LspServiceOptions,
  type LspQueryContext,
  type EditDiagnosticsRequest,
  type EditDiagnosticsResult,
} from "./service.js";
export { LspServerRegistry, type LspServerMatch } from "./registry.js";
export type { LspDocumentSync } from "./document-sync.js";
export { LSP_EDIT_DIAGNOSTICS_WAIT_MS, LSP_MAX_OPEN_DOCUMENTS } from "./constants.js";

import { LspService, type LspServiceOptions } from "./service.js";

/** Factory used by bootstrap: one service per session; pass the process-wide `documents` owner. */
export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}
