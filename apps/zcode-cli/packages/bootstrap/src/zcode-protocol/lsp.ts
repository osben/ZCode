// Protocol handlers for lsp/preferences/get, lsp/preferences/set and lsp/status.
// Preferences are owned by LspPreferencesStore (fork sidecar). The runtime that owns language server
// processes is reached only through LspProtocolHost, so these handlers never touch the pool directly.
import type { LspPreferences } from "@zcode/contracts";
import {
  zcodeLspPreferencesGetParamsSchema,
  zcodeLspPreferencesGetResultSchema,
  zcodeLspPreferencesSetParamsSchema,
  zcodeLspPreferencesSetResultSchema,
  zcodeLspStatusParamsSchema,
  zcodeLspStatusResultSchema,
  type ZCodeLspPreferences,
  type ZCodeLspPreferencesGetResult,
  type ZCodeLspPreferencesSetResult,
  type ZCodeLspStatusResult,
} from "@zcode/shared";
import type { LspPreferencesStore } from "../app/lsp-preferences.js";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/** JSON-RPC server error used when the runtime was started without an LSP host. */
const LSP_HOST_UNAVAILABLE_CODE = -32000;

/**
 * Runtime-side collaborators for the LSP protocol surface. The CLI composition root (create-app)
 * builds one instance per process and assigns it to `context.lsp`.
 */
export interface LspProtocolHost {
  /** Single owner of fork_lsp_preferences.json. */
  preferences: LspPreferencesStore;
  /** Current server states for the requested workspace. Must not start servers. */
  getStatus(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeLspStatusResult>;
  /**
   * Pushes persisted preferences into the running registry and pool, so changes apply without a
   * restart. Called after every successful `preferences.update`.
   */
  applyPreferences(prefs: LspPreferences): Promise<void>;
}

export async function getLspPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeLspPreferencesGetResult> {
  parseParams(zcodeLspPreferencesGetParamsSchema, rawParams);
  const host = requireLspHost(context);
  // Re-read so a hand-edited or repaired sidecar is reflected; load never throws on bad content.
  const loaded = await host.preferences.load();
  return zcodeLspPreferencesGetResultSchema.parse(toProtocolPreferences(loaded));
}

export async function setLspPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeLspPreferencesSetResult> {
  const params = parseParams(zcodeLspPreferencesSetParamsSchema, rawParams);
  const host = requireLspHost(context);
  const next = await host.preferences.update(params.patch);
  await host.applyPreferences(next);
  return zcodeLspPreferencesSetResultSchema.parse(toProtocolPreferences(next));
}

export async function getLspStatus(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeLspStatusResult> {
  const params = parseParams(zcodeLspStatusParamsSchema, rawParams);
  const host = requireLspHost(context);
  return zcodeLspStatusResultSchema.parse(await host.getStatus(params.workspace));
}

function requireLspHost(context: ZCodeProtocolAgentServerContext): LspProtocolHost {
  if (!context.lsp) {
    throw new ProtocolRequestError(
      LSP_HOST_UNAVAILABLE_CODE,
      "Language server support is not available in this runtime",
    );
  }
  return context.lsp;
}

/** Protocol shape omits the sidecar `version` field, which is storage-only. */
function toProtocolPreferences(prefs: LspPreferences): ZCodeLspPreferences {
  return {
    enabled: prefs.enabled,
    diagnosticsAfterEdit: { ...prefs.diagnosticsAfterEdit },
  };
}
