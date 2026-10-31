// ============================================================
// Read Tool Handler
// ============================================================

import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolEntry,
  ToolInputValidationResult,
} from "../types.js";
import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  ReadInputJsonSchema,
  ReadInputSchema,
  ReadOutputJsonSchema,
  ReadOutputSchema,
  createCoreError,
  getReadPdfPagesValidationFailure,
  isCoreError,
  isFileSystemPortError,
  type ReadInput,
  type ReadImageOutput,
  type ReadVideoOutput,
  type ModelMessageContent,
  type ReadOutput,
  type ReadTextOutput,
  type FileSystemPort,
  type FileSystemStatResult,
  type TraceContext,
} from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
  requestedPathField,
  setReadFileStateEntry,
} from "../read-file-state.js";
import { createReadFileStateMetadata } from "../read-file-state-metadata.js";
import { inferImageMimeFromPath, readImageFile } from "./read-image.js";
import { inferVideoMimeFromPath } from "../../runtime/helpers/attachment-video.js";
import { readVideoFile } from "./read-video.js";
import {
  READ_FILE_UNCHANGED_STUB,
  READ_OUTPUT_TOO_MANY_TOKENS_CODE,
  formatReadBatchNotice,
  formatReadTextOutput,
  readTextFileForModel,
} from "./read-text.js";
import {
  formatReadPdfOutput,
  formatReadPdfPagesOutput,
  isPdfPath,
  READ_PDF_TOOL_TIMEOUT_MS,
  readPdfFile,
  resolveReadInputSchema,
  resolveReadProviderDescription,
  resolveReadTimeoutBudgetMs,
  supportsPdfForExecution,
} from "./read-pdf.js";

export { addReadLineNumbers } from "./read-text.js";

const READ_PROVIDER_DESCRIPTION = [
  "Reads a file from the local filesystem.",
  "",
  "- `file_path` must be an absolute path.",
  `- Reads up to ${READ_DEFAULT_MAX_LINES} lines by default.`,
  "- When you already know which part of the file you need, only read that part. This can be important for larger files.",
  "- Results are returned using cat -n format, with line numbers starting at 1",
  "- Reads images (PNG, JPG, …) and presents them visually.",
  "- Reads videos (MP4, MOV, WEBM, …) and presents them as video input (subject to ZCode's video input limit).",
  "- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.",
  "- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.",
].join("\n");

const fallbackReadFileStates = new WeakMap<ToolExecutionContext, ReadFileStateMap>();

function formatReadModelContent(output: unknown): ModelMessageContent {
  const parsed = ReadOutputSchema.safeParse(output);
  if (!parsed.success) {
    return stringifyReadOutputFallback(output);
  }

  return formatReadOutput(parsed.data);
}

function formatReadOutput(output: ReadOutput): ModelMessageContent {
  switch (output.type) {
    case "text":
      return formatReadTextToolResult(output);
    case "file_unchanged":
      return READ_FILE_UNCHANGED_STUB;
    case "image":
      return formatReadImageOutput(output);
    case "video":
      return formatReadVideoOutput(output);
    case "pdf":
      return formatReadPdfOutput(output);
    case "parts":
      return formatReadPdfPagesOutput(output);
    case "notebook":
      return stringifyReadOutputFallback(output);
  }
}

/** Body of a text Read tool_result; files restored after compaction use the same format. */
export function formatReadTextToolResult(output: ReadTextOutput): string {
  // The partial-view notice is sent as an attachment after the tool batch; the tool_result holds only the numbered body.
  const { partialViewNotice: _notice, ...textOutput } = output;
  return formatReadTextOutput(textOutput);
}

function formatReadImageOutput(output: ReadImageOutput): ModelMessageContent {
  const imageBlock = {
    type: "image" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-image",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read image",
      sizeBytes: output.originalSize,
    },
  };
  // Including dimension hints in tool results would make provider-visible content vary based on whether the image was resized.
  // Keep image results to the media block; dimensions remain in structured output for the UI and debugging.
  return [imageBlock];
}

// Same as images: tool results contain only the media block; OpenAI-family providers split it into a trailing user part through
// tool-result-media-projection (the AI SDK has no video part variant for tool results).
function formatReadVideoOutput(output: ReadVideoOutput): ModelMessageContent {
  const videoBlock = {
    type: "video" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-video",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read video",
      sizeBytes: output.originalSize,
    },
  };
  return [videoBlock];
}

function stringifyReadOutputFallback(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}

export const readHandler: ToolHandler = async (input, context) => {
  const { file_path, offset, limit, pages } = parseReadInput(input);
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  try {
    const imageMime = inferImageMimeFromPath(filePath);
    if (imageMime) {
      return await readImageFile(filePath, imageMime, context);
    }

    const videoMime = inferVideoMimeFromPath(filePath);
    if (videoMime) {
      return await readVideoFile(filePath, videoMime, context);
    }

    if (isPdfPath(filePath) && supportsPdfForExecution(context)) {
      return await readPdfFile({ filePath, pages }, context);
    }

    const trace = createReadTrace(context);
    const stat = await fileSystemPort.stat(
      { path: filePath, trace },
      { signal: context.abortSignal },
    );
    const readFileState = getReadFileState(context);
    const cacheOffset = normalizeCacheOffset(offset);
    const cached = findLatestReadFileState(readFileState, filePath);
    if (cached && isSameReadView(cached, cacheOffset, limit) && isCachedReadFresh(cached, stat)) {
      // Fix reason: the snapshot here is only a copy of the latest record at that time, so a cold resume that replays
      // it would restore a view that is no longer in active history (for example, the real read was already
      // summarized by compaction). Do not write live state and do not record a snapshot.
      return { type: "file_unchanged", filePath } satisfies ReadOutput;
    }

    let rangeReadRevision: FileSystemStatResult["revision"] | undefined;
    // Text reads start the language server for this file type in the background (acquire only, never waits).
    context.lspPrewarm?.(filePath);
    const output = await readTextFileForModel({
      abortSignal: context.abortSignal,
      filePath,
      fileSystemPort,
      limit,
      onRead: (read) => {
        rangeReadRevision = read.revision;
      },
      offset,
      trace,
    });
    updateReadFileState(readFileState, {
      output,
      path: filePath,
      requestedPath: file_path,
      stat,
      rangeReadRevision,
      offset,
      limit,
    });
    recordReadFileStateMetadata(context, {
      output,
      readFileState,
      toolInput: input,
    });
    return output;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      const message = await createMissingReadFileMessage(filePath, context);
      throw createCoreError(CoreErrorType.ToolExecutionFailed, message, {
        cause: error,
        context: {
          code: "read_file_not_found",
          filePath,
        },
        recoverable: true,
      });
    }
    if (isFileSystemPortError(error) && error.code === "too_large") {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_file_too_large",
          filePath,
          maxBytes: READ_MAX_FILE_SIZE_BYTES,
        },
        recoverable: true,
      });
    }
    throw error;
  }
};

function parseReadInput(input: unknown): ReadInput {
  const parsed = ReadInputSchema.safeParse(input);
  if (parsed.success) return parsed.data as ReadInput;

  const toolUseErrorMessage = getReadInputToolUseErrorMessage(parsed.error);
  if (!toolUseErrorMessage) {
    throw parsed.error;
  }

  // A Read input preflight failure should reach the provider as <tool_use_error> text.
  // Exposing raw ZodError JSON would make binary/device preflight differ from capture.
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `<tool_use_error>${toolUseErrorMessage}</tool_use_error>`,
    {
      cause: parsed.error,
      context: {
        code: "read_input_preflight_failed",
      },
      recoverable: true,
    },
  );
}

function validateReadInput(input: unknown): ToolInputValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { result: true };
  }

  const candidate = input as { file_path?: unknown; pages?: unknown };
  if (typeof candidate.file_path !== "string" || typeof candidate.pages !== "string") {
    return { result: true };
  }

  // If PDF pages constraints exist only in the runtime schema, JSON Schema accepts any string, so invalid calls pass Hook and
  // permission checks before the handler throws a raw ZodError.
  const failure = getReadPdfPagesValidationFailure(candidate.file_path, candidate.pages);
  return failure ? { result: false, ...failure } : { result: true };
}

function getReadInputToolUseErrorMessage(error: unknown): string | undefined {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;

  for (const issue of issues) {
    if (!isReadInputToolUseIssue(issue)) continue;
    return issue.message;
  }
  return undefined;
}

function isReadInputToolUseIssue(issue: unknown): issue is { message: string } {
  if (!issue || typeof issue !== "object") return false;
  const record = issue as { code?: unknown; message?: unknown; path?: unknown };
  if (record.code !== "custom" || typeof record.message !== "string") return false;
  if (!Array.isArray(record.path)) return false;
  return record.path.length === 1 && record.path[0] === "file_path";
}

function createReadTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function getReadFileState(context: ToolExecutionContext): ReadFileStateMap {
  if (context.readFileState) return context.readFileState;
  const existing = fallbackReadFileStates.get(context);
  if (existing) return existing;
  const state: ReadFileStateMap = new Map();
  fallbackReadFileStates.set(context, state);
  return state;
}

function normalizeCacheOffset(offset: number | undefined): number {
  return offset === undefined ? 1 : offset;
}

// Deduplicate only against the file's most recent view, and that view must come from Read.
// Fix reason: after Edit/Write the state was recorded under the full-view key, so a Read hitting that key returned the
// Wasted call stub even though the model had not seen the written content; reading the full file after reading other
// ranges in between would also hit an earlier full view.
function isSameReadView(
  entry: ReadFileStateEntry,
  offset: number,
  limit: number | undefined,
): boolean {
  return (
    (entry.sourceTool === undefined || entry.sourceTool === "Read") &&
    normalizeCacheOffset(entry.offset) === offset &&
    entry.limit === limit
  );
}

function isCachedReadFresh(entry: ReadFileStateEntry, stat: FileSystemStatResult): boolean {
  if (entry.isPartialView) return false;

  const mtimeMs = stat.revision?.mtimeMs ?? stat.mtimeMs;
  if (entry.mtimeMs !== undefined && mtimeMs !== undefined) {
    // Use the same policy as pre-write freshness validation; compare mtime only at integer-millisecond precision.
    return (
      normalizeReadFileStateMtimeMs(entry.mtimeMs) === normalizeReadFileStateMtimeMs(mtimeMs) &&
      entry.sizeBytes === stat.sizeBytes
    );
  }

  const revisionId = stat.revision?.id;
  if (entry.revisionId && revisionId) return entry.revisionId === revisionId;

  return entry.sizeBytes !== undefined && entry.sizeBytes === stat.sizeBytes;
}

interface ReadTextFileStateInput {
  output: ReadTextOutput;
  path: string;
  requestedPath?: string;
  stat: FileSystemStatResult;
  rangeReadRevision?: FileSystemStatResult["revision"];
  offset?: number;
  limit?: number;
}

function updateReadFileState(state: ReadFileStateMap, input: ReadTextFileStateInput): void {
  setReadFileStateEntry(state, createReadTextFileStateEntry(input));
}

function createReadTextFileStateEntry(input: ReadTextFileStateInput): ReadFileStateEntry {
  const revision = input.stat.revision ?? input.rangeReadRevision;
  return {
    path: input.path,
    ...requestedPathField(input.requestedPath, input.path),
    content: input.output.content,
    offset: input.offset,
    limit: input.limit,
    // offset/limit define a range view, not a partial view.
    // A partial view means the tool truncated content seen by the model, which Write/Edit must reject as incomplete.
    isPartialView: input.output.truncatedByTokenCap === true,
    readAt: new Date(),
    sourceTool: "Read",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs ?? input.stat.mtimeMs),
    sizeBytes: input.stat.sizeBytes,
  };
}

/** Result of one whole-file read when restoring files after compaction. */
export type PostCompactFileRead =
  | {
      type: "text";
      output: ReadTextOutput;
      /** Read-state entry for this read; the caller writes it after compaction persists successfully. */
      readFileStateEntry: ReadFileStateEntry;
    }
  /** Exceeds the Read file-size or token limit; only a reference notice can be placed. */
  | { type: "too_large" }
  /** Paths that are not restored: binaries and device files that fail the Read preflight, plus images, videos, and PDFs. */
  | { type: "skipped" };

/**
 * Restore a file after compaction: read the current on-disk content with Read's whole-file semantics (no offset / limit).
 * It bypasses the executor and does not write read state. The caller decides permissions; other read errors are thrown as-is.
 */
export async function readFileForCompactRestore(input: {
  abortSignal?: AbortSignal;
  filePath: string;
  fileSystemPort: FileSystemPort;
  trace?: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<PostCompactFileRead> {
  if (!ReadInputSchema.safeParse({ file_path: input.filePath }).success) return { type: "skipped" };
  const filePath = resolveWorkspacePath({
    inputPath: input.filePath,
    operation: "read",
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
  if (inferImageMimeFromPath(filePath) || inferVideoMimeFromPath(filePath) || isPdfPath(filePath)) {
    return { type: "skipped" };
  }

  const { abortSignal, fileSystemPort, trace } = input;
  try {
    const stat = await fileSystemPort.stat({ path: filePath, trace }, { signal: abortSignal });
    let rangeReadRevision: FileSystemStatResult["revision"] | undefined;
    const output = await readTextFileForModel({
      abortSignal,
      filePath,
      fileSystemPort,
      onRead: (read) => {
        rangeReadRevision = read.revision;
      },
      trace,
    });
    return {
      type: "text",
      output,
      readFileStateEntry: createReadTextFileStateEntry({
        output,
        path: filePath,
        rangeReadRevision,
        stat,
      }),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") return { type: "too_large" };
    if (isCoreError(error) && error.context?.code === READ_OUTPUT_TOO_MANY_TOKENS_CODE) {
      return { type: "too_large" };
    }
    throw error;
  }
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  input: {
    output: ReadTextOutput;
    readFileState: ReadFileStateMap;
    toolInput: unknown;
  },
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadata({
    completedAt: new Date(),
    output: input.output,
    readFileState: input.readFileState,
    toolInput: input.toolInput,
    toolName: "Read",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

async function createMissingReadFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  const suggestion = await findSimilarFilename(filePath, context);
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return undefined;

  try {
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createReadTrace(context) },
      { signal: context.abortSignal },
    );
    const entries = listed.entries
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      .filter((name) => name !== targetName)
      .sort();

    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    return undefined;
  }
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index]!;
    }
  }

  return previous[right.length] ?? 0;
}

export const readToolEntry: ToolEntry = {
  capability:
    "Read text files and supported images from the file-system adapter without modifying files",
  metadata: {
    name: "Read",
    description: READ_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: READ_MAX_FILE_SIZE_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: readHandler,
  validateInput: validateReadInput,
  resolveModelContract: (context) => ({
    description: resolveReadProviderDescription(READ_PROVIDER_DESCRIPTION, context),
    inputSchema: resolveReadInputSchema(context),
  }),
  resolveTimeoutBudgetMs: resolveReadTimeoutBudgetMs,
  formatModelContent: formatReadModelContent,
  formatBatchNotice: formatReadBatchNotice,
  inputSchema: ReadInputJsonSchema,
  outputSchema: ReadOutputJsonSchema,
  runtimeInputSchema: ReadInputSchema,
  runtimeOutputSchema: ReadOutputSchema,
  permission: {
    permission: "read",
    reason: "Read only inspects file content and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: READ_MAX_FILE_SIZE_BYTES,
    maxModelBytes: READ_MAX_FILE_SIZE_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: READ_MAX_FILE_SIZE_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: READ_PDF_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "required",
    userVisibleMessage: "Read was cancelled before file content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
