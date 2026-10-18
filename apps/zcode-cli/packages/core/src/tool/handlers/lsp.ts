// ============================================================
// LSP Tool Handler (spec docs/design/v2/tool/19-lsp.md §7)
// ============================================================

import {
  CoreErrorType,
  LSP_TOOL_NAME,
  LspError,
  LspInputJsonSchema,
  LspInputSchema,
  LspOutputJsonSchema,
  LspOutputSchema,
  createCoreError,
  type LspErrorCode,
  type LspInput,
  type TraceContext,
} from "@zcode/contracts";
import { isPositionalOperation } from "../../lsp/operations.js";
import { resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { formatLspModelContent } from "./lsp-format.js";

const LSP_TOOL_TIMEOUT_MS = 65_000;
const LSP_MODEL_MAX_BYTES = 100_000;
/** Codes the model may retry after a short wait (spec §7 error codes). */
const LSP_RETRYABLE_CODES: ReadonlySet<LspErrorCode> = new Set<LspErrorCode>([
  "lsp_server_starting",
  "lsp_request_timeout",
  "lsp_server_crashed",
  "lsp_cancelled",
]);

const LSP_TOOL_DESCRIPTION = [
  "Code intelligence from language servers: definition, references, implementations, hover, document and workspace symbols, and diagnostics for a file.",
  "Use it for symbols and types. Use Grep for plain text and configuration.",
  "Give line (1-based, as shown by Read) plus symbol (the identifier on that line, preferred) or character (1-based column).",
  "A status of pending means the server has not answered yet; it does not mean there are no errors.",
].join(" ");

export const lspHandler: ToolHandler = async (input, context) => {
  const parsed = LspInputSchema.parse(input) as LspInput;
  validateOperationInput(parsed, context);

  const lsp = context.lsp;
  if (!lsp) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "LSP service is not configured for the LSP tool",
      { context: { toolCallId: context.toolCallId, toolName: LSP_TOOL_NAME }, recoverable: false },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: parsed.filePath,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });
  try {
    return await lsp.query(
      parsed.operation,
      { ...parsed, filePath },
      { signal: context.abortSignal, trace: createLspTrace(context) },
    );
  } catch (error) {
    if (error instanceof LspError) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: error.code,
          toolCallId: context.toolCallId,
          toolName: LSP_TOOL_NAME,
        },
        recoverable: LSP_RETRYABLE_CODES.has(error.code),
      });
    }
    throw error;
  }
};

export const lspToolEntry: ToolEntry = {
  capability:
    "Query language servers for definitions, references, hover, symbols, implementations and diagnostics",
  metadata: {
    name: LSP_TOOL_NAME,
    description: LSP_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LSP_TOOL_TIMEOUT_MS,
    maxOutputBytes: LSP_MODEL_MAX_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: lspHandler,
  inputSchema: LspInputJsonSchema,
  outputSchema: LspOutputJsonSchema,
  runtimeInputSchema: LspInputSchema,
  runtimeOutputSchema: LspOutputSchema,
  formatModelContent: formatLspModelContent,
  permission: {
    permission: "read",
    reason: "LSP only reads source through language servers started from trusted plugins",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: LSP_MODEL_MAX_BYTES,
    maxModelBytes: LSP_MODEL_MAX_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: LSP_MODEL_MAX_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: LSP_TOOL_TIMEOUT_MS,
    maxMs: LSP_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LSP request was cancelled before the language server answered",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** Input rules that the schema cannot express (spec §7). Failures are invalid-input errors. */
function validateOperationInput(input: LspInput, context: ToolExecutionContext): void {
  const fail = (message: string): never => {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, message, {
      context: {
        code: "lsp_invalid_position",
        toolCallId: context.toolCallId,
        toolName: LSP_TOOL_NAME,
      },
      recoverable: true,
    });
  };
  if (input.operation === "workspaceSymbol") {
    if (!input.query) fail("workspaceSymbol requires query");
    return;
  }
  if (!isPositionalOperation(input.operation)) return;
  if (input.line === undefined) fail(`${input.operation} requires line`);
  const hasCharacter = input.character !== undefined;
  const hasSymbol = input.symbol !== undefined;
  if (hasCharacter === hasSymbol)
    fail(`${input.operation} requires exactly one of character or symbol`);
}

function createLspTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
