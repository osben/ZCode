// ============================================================
// Language Server (LSP) contracts
// ============================================================
// Spec: apps/zcode-cli/docs/design/v2/tool/19-lsp.md

import { z } from "zod";

// -----------------------------------------------
// Plugin manifest `lspServers` entry (Claude Code compatible, strict)
// -----------------------------------------------

const positiveIntegerMs = z.number().int().positive();

export const LspServerConfigSchema = z
  .object({
    command: z.string().min(1),
    extensionToLanguage: z
      .record(z.string().regex(/^\.[^\s/\\]+$/u), z.string().min(1))
      .refine((value) => Object.keys(value).length > 0, {
        message: "extensionToLanguage needs at least one entry",
      }),
    args: z.array(z.string()).optional(),
    transport: z.enum(["stdio", "socket"]).optional(),
    env: z.record(z.string()).optional(),
    initializationOptions: z.unknown().optional(),
    settings: z.unknown().optional(),
    workspaceFolder: z.string().min(1).optional(),
    startupTimeout: positiveIntegerMs.optional(),
    shutdownTimeout: positiveIntegerMs.optional(),
    requestTimeout: positiveIntegerMs.optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().int().min(0).optional(),
    diagnostics: z.boolean().optional(),
  })
  .strict();

export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

export const LSP_DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const LSP_DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
export const LSP_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const LSP_DEFAULT_MAX_RESTARTS = 3;

/**
 * A server after plugin loading: templates expanded, defaults applied, namespaced id.
 * Produced only by the plugin loader; consumers never re-read the manifest.
 */
export interface ResolvedLspServer {
  /** `<pluginId>/<serverName>`, stable across sessions; the key for preferences and status. */
  id: string;
  pluginId: string;
  serverName: string;
  /** Load priority of the declaring plugin; the lower value (loaded earlier) wins an extension conflict. */
  priority: number;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Extension (with dot, case preserved) → LSP languageId. Already conflict-resolved. */
  extensionToLanguage: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  /** Workspace-relative folder used as root; undefined means the workspace root. */
  workspaceFolder?: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  requestTimeoutMs: number;
  restartOnCrash: boolean;
  maxRestarts: number;
  /** Manifest default for post-edit diagnostics; user preferences may override it. */
  diagnosticsAfterEdit: boolean;
}

// -----------------------------------------------
// User preferences (fork-owned sidecar, see spec §3)
// -----------------------------------------------

export const LSP_PREFERENCES_FILE_NAME = "fork_lsp_preferences.json";

export const LspPreferencesSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    diagnosticsAfterEdit: z.record(z.boolean()),
  })
  .strict();

export type LspPreferences = z.infer<typeof LspPreferencesSchema>;

export const DEFAULT_LSP_PREFERENCES: LspPreferences = {
  version: 1,
  enabled: true,
  diagnosticsAfterEdit: {},
};

// -----------------------------------------------
// Errors and status
// -----------------------------------------------

export type LspErrorCode =
  | "lsp_disabled"
  | "lsp_no_server_for_file"
  | "lsp_server_not_installed"
  | "lsp_server_starting"
  | "lsp_request_timeout"
  | "lsp_request_failed"
  | "lsp_server_start_failed"
  | "lsp_startup_timeout"
  | "lsp_server_crashed"
  | "lsp_server_unavailable"
  | "lsp_operation_unsupported"
  | "lsp_invalid_input"
  | "lsp_invalid_position"
  | "lsp_symbol_not_found_on_line"
  | "lsp_remote_unsupported"
  | "lsp_cancelled";

export class LspError extends Error {
  constructor(
    readonly code: LspErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LspError";
  }
}

export type LanguageServerState =
  | "stopped"
  | "starting"
  | "ready"
  | "crashed"
  | "unavailable"
  | "not_installed";

export const LanguageServerStateSchema = z.enum([
  "stopped",
  "starting",
  "ready",
  "crashed",
  "unavailable",
  "not_installed",
]);

export const LanguageServerStatusSchema = z
  .object({
    serverId: z.string(),
    identityKey: z.string(),
    workspacePath: z.string(),
    state: LanguageServerStateSchema,
    restarts: z.number().int().min(0),
    /** Whether the server can attribute versionless publishes or supports pull diagnostics. */
    diagnosticsMode: z.enum(["pull", "versioned", "attributed", "unknown"]),
    lastErrorCode: z.string().optional(),
  })
  .strict();

export type LanguageServerStatus = z.infer<typeof LanguageServerStatusSchema>;

// -----------------------------------------------
// Normalized diagnostics (1-based, model-facing)
// -----------------------------------------------

export type LspDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface LspDiagnostic {
  /** Absolute file path. Model-facing projections relativize it. */
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: LspDiagnosticSeverity;
  message: string;
  code?: string;
  source?: string;
}

/** Published by Edit/Write after a successful write; consumed only by the LSP document sync. */
export interface FileMutatedEvent {
  /** Absolute path. */
  path: string;
  kind: "created" | "changed" | "deleted";
  /** Full new content; undefined for deletions. */
  content?: string;
  /** 1-based inclusive changed line range in the new content, when known. */
  changedRange?: { startLine: number; endLine: number };
  traceId?: string;
  sessionId?: string;
}

export type FileMutationSink = (event: FileMutatedEvent) => void;
