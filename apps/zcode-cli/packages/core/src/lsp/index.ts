// ============================================================
// LSP core public entry (spec docs/design/v2/tool/19-lsp.md)
// ============================================================

export {
  LspService,
  type LspServiceOptions,
  type LspQueryContext,
  type EditDiagnosticsRequest,
  type EditDiagnosticsResult,
} from "./service.js";
export { LspServerRegistry, type LspServerMatch } from "./registry.js";
export { LSP_EDIT_DIAGNOSTICS_WAIT_MS, LSP_MAX_OPEN_DOCUMENTS } from "./constants.js";

import { LspService, type LspServiceOptions } from "./service.js";

/** Factory used by bootstrap: one service per workspace key, shared by the sessions of that workspace. */
export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}
