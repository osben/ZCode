// ============================================================
// Query path of LspService: one LSP operation for the tool (spec §5, §7)
// ============================================================
// Startup never blocks: a starting server answers with lsp_server_starting. Errors are LspError
// with stable codes, which the tool maps to structured errors.

import { isAbsolute } from "node:path";
import {
  LspError,
  type FileSystemPort,
  type LanguageServerConnection,
  type LanguageServerKey,
  type LanguageServerPort,
  type LspInput,
  type LspOperation,
  type LspOutput,
  type ResolvedLspServer,
  type TraceContext,
} from "@zcode/contracts";
import { LSP_DIAGNOSTICS_QUERY_WAIT_MS } from "./constants.js";
import { LspDocumentSync, syncContextFor } from "./document-sync.js";
import type { OpenDocument } from "./document-store.js";
import type { FreshnessWaiters } from "./freshness-waiters.js";
import {
  buildOperationRequest,
  isPositionalOperation,
  OPERATION_CAPABILITY,
} from "./operations.js";
import {
  projectDiagnostics,
  projectOperationResult,
  SourceLineReader,
} from "./operation-output.js";
import { resolveModelPosition, type LspZeroBasedPosition } from "./position.js";
import type { LspServerRegistry, LspServerMatch } from "./registry.js";

export interface QueryEnvironment {
  registry: LspServerRegistry;
  port: LanguageServerPort;
  key: LanguageServerKey;
  fileSystem: FileSystemPort;
  sync: LspDocumentSync;
  waiters: FreshnessWaiters;
  assertEnabled(): void;
}

export interface QueryContext {
  signal?: AbortSignal;
  trace?: TraceContext;
}

export async function runLspQuery(
  env: QueryEnvironment,
  operation: LspOperation,
  input: LspInput,
  context: QueryContext,
): Promise<LspOutput> {
  env.assertEnabled();
  const workspacePath = env.key.workspacePath;
  const match = matchFor(env.registry, operation, input.filePath);
  const server = match.server;
  if (!(await env.port.isInstalled(server))) {
    throw new LspError(
      "lsp_server_not_installed",
      `Language server ${server.id} is not installed on this machine`,
    );
  }
  const connection = readyConnection(env.port, server, env.key, context.trace);
  const capability = OPERATION_CAPABILITY[operation];
  if (capability !== undefined && !connection.capabilities[capability]) {
    throw new LspError(
      "lsp_operation_unsupported",
      `Language server ${server.id} does not support ${operation}`,
    );
  }
  const reader = new SourceLineReader(env.fileSystem, {
    trace: context.trace,
    signal: context.signal,
  });

  if (operation === "workspaceSymbol") {
    const request = buildOperationRequest({
      operation,
      uri: "",
      position: { line: 0, character: 0 },
      query: input.query,
    });
    if (!request) throw new LspError("lsp_operation_unsupported", "workspaceSymbol has no request");
    const raw = await connection.request(request.method, request.params, {
      signal: context.signal,
    });
    return projectOperationResult({
      operation,
      serverId: server.id,
      raw,
      documentUri: "",
      workspacePath,
      reader,
    });
  }

  const document = await env.sync.ensureOpen(
    syncContextFor(match, env.key, connection, context),
    input.filePath,
  );
  if (operation === "diagnostics") {
    return diagnosticsOperation(env, server.id, document, context);
  }

  // Only positional operations need a resolved position; documentSymbol is per file.
  const position = isPositionalOperation(operation)
    ? resolveInputPosition(document.lines, input)
    : { line: 0, character: 0 };
  const request = buildOperationRequest({
    operation,
    uri: document.uri,
    position,
    includeDeclaration: input.includeDeclaration,
  });
  if (!request)
    throw new LspError("lsp_operation_unsupported", `Unsupported operation ${operation}`);
  const raw = await connection.request(request.method, request.params, { signal: context.signal });
  return projectOperationResult({
    operation,
    serverId: server.id,
    raw,
    documentUri: document.uri,
    workspacePath,
    reader,
  });
}

async function diagnosticsOperation(
  env: QueryEnvironment,
  serverId: string,
  document: OpenDocument,
  context: QueryContext,
): Promise<LspOutput> {
  const workspacePath = env.key.workspacePath;
  await env.waiters.wait(
    () => document.freshness.isFreshForCurrent(),
    LSP_DIAGNOSTICS_QUERY_WAIT_MS,
    context.signal,
  );
  const fresh = document.freshness.currentFresh();
  if (fresh === undefined) {
    return projectDiagnostics(serverId, [], workspacePath, "pending");
  }
  return projectDiagnostics(serverId, fresh.items, workspacePath, "ok");
}

function matchFor(
  registry: LspServerRegistry,
  operation: LspOperation,
  filePath: string,
): LspServerMatch {
  if (!isAbsolute(filePath)) {
    throw new LspError("lsp_invalid_position", "filePath must be absolute");
  }
  const match = registry.forFile(filePath);
  if (!match) {
    throw new LspError(
      "lsp_no_server_for_file",
      `No language server is configured for ${operation} on this file type`,
    );
  }
  return match;
}

function readyConnection(
  port: LanguageServerPort,
  server: ResolvedLspServer,
  key: LanguageServerKey,
  trace: TraceContext | undefined,
): LanguageServerConnection {
  const result = port.acquire(server, key, { trace });
  if (result.state === "ready") return result.connection;
  if (result.state === "starting") {
    throw new LspError(
      "lsp_server_starting",
      `Language server ${server.id} is starting; retry shortly; use Grep meanwhile`,
    );
  }
  throw new LspError(result.code, result.message);
}

function resolveInputPosition(lines: readonly string[], input: LspInput): LspZeroBasedPosition {
  if (input.line === undefined) {
    throw new LspError("lsp_invalid_position", "line is required for this operation");
  }
  return resolveModelPosition(lines, {
    line: input.line,
    character: input.character,
    symbol: input.symbol,
  });
}
