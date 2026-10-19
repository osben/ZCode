import {
  CoreErrorType,
  createCoreError,
  modelMessageContentToText,
  traceContextToLogContext,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ToolResultBudget,
  type TraceContext,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  containsOfficialCuaImageRefCredentialText,
} from "@zcode/zcode-cua/frame-contract";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import { formatHookAdditionalContexts } from "./hook-flow.js";
import {
  formatGenericPersistedOutputContent,
  isPersistedOutputContent,
} from "../result-persistence-format.js";
import {
  appendHookToPersistedArtifactPreview,
  appendHookToStringContent,
  appendHookWithoutReorderingStructuredContent,
  fitContentWithSuffix,
  OfficialCuaFrameContractError,
  projectHookAugmentedModelContent,
  projectOfficialCuaStructuredContent,
} from "./result-content-projection.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";

const DEFAULT_RESULT_BUDGET: ToolResultBudget = {
  maxInlineBytes: 100_000,
  maxModelBytes: 100_000,
  strategy: "truncate",
  preview: {
    direction: "head",
  },
};

export const OFFICIAL_CUA_INVALID_RASTER_RECOVERY_TEXT =
  "This CUA raster is invalid and cannot be used in this request. " +
  "Do not send a coordinate target; capture a new raster first.";

export async function serializeOutput(
  deps: ToolExecutorDeps,
  output: unknown,
  entry: ToolEntry,
  traceContext: TraceContext,
  toolCallId: string,
  signal: AbortSignal,
): Promise<ToolResultSerialization> {
  const effectiveBudget: ToolResultBudget = entry.resultBudget ?? DEFAULT_RESULT_BUDGET;
  const modelContent = stringifyOutputForModel(output, entry);
  const content = stringifyModelContentForSerialization(modelContent);
  if (isEmptyModelContent(modelContent)) {
    // Empty Bash output also needs a generic placeholder so the model does not mistake a silent success for a missing tool result.
    const emptyContent = `(${entry.metadata.name} completed with no output)`;
    return {
      content: emptyContent,
      modelContent: emptyContent,
      originalBytes: Buffer.byteLength(content, "utf8"),
      returnedBytes: Buffer.byteLength(emptyContent, "utf8"),
      truncated: false,
      budgetStrategy: effectiveBudget.strategy,
    };
  }

  const contentType =
    entry.resultArtifactContentType ??
    (typeof output === "string" ? "text/plain" : "application/json");
  const originalBytes = Buffer.byteLength(content, "utf8");
  // Some provider contracts count JavaScript characters. Preserve the existing UTF-8
  // byte budget for other tools, and add this persistence threshold only for tools that
  // explicitly declare a character limit.
  const exceedsCharacterBudget =
    entry.maxModelChars !== undefined && content.length > entry.maxModelChars;
  const maxModelBytes = Math.max(
    0,
    Math.min(effectiveBudget.maxModelBytes, effectiveBudget.maxInlineBytes),
  );
  const artifactPath = findArtifactPath(output);
  const shouldPersistArtifact =
    (originalBytes > maxModelBytes || exceedsCharacterBudget) &&
    effectiveBudget.artifact?.enabled === true &&
    effectiveBudget.strategy === "artifact";
  const artifact = shouldPersistArtifact
    ? await tryWriteToolArtifact(
        deps,
        content,
        contentType,
        entry,
        effectiveBudget,
        traceContext,
        toolCallId,
        signal,
      )
    : undefined;
  const resolvedArtifactPath = artifact?.path ?? artifact?.uri ?? artifactPath;

  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION &&
    hasImageBlock(modelContent)
  ) {
    let protectedProjection;
    try {
      protectedProjection = projectOfficialCuaStructuredContent(
        modelContent,
        maxModelBytes,
        effectiveBudget.preview?.direction ?? "head",
      );
    } catch (error) {
      if (!(error instanceof OfficialCuaFrameContractError)) throw error;
      // Non-canonical frames must still fail closed, but low-level layout invariants
      // must not be exposed to the model as tool results. Record a stable diagnostic
      // here, then let the executor produce a recoverable error result.
      deps.logger?.warn("Official CUA frame contract rejected during result serialization", {
        ...traceContextToLogContext(traceContext),
        code: error.code,
        event: "tool.result.cua_frame_contract_rejected",
        module: "core.tool.executor",
        status: "failed",
        toolCallId,
        toolName: entry.metadata.name,
      });
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        OFFICIAL_CUA_INVALID_RASTER_RECOVERY_TEXT,
        {
          context: { code: error.code, source: "tool" },
          recoverable: true,
        },
      );
    }
    if (protectedProjection) {
      const projectedModelContent = protectedProjection.content;
      const projectedContent = stringifyModelContentForSerialization(projectedModelContent);
      const projectedBytes = Buffer.byteLength(projectedContent, "utf8");
      // In serialized text, an image block is only a short placeholder; the real base64
      // raster (up to the bridge's 200 KiB limit) is sent to the model unchanged.
      // returnedBytes means bytes sent to the model, so it must include the image
      // payload. Otherwise setOutputBytes / turn-tool-usage / usage-observability would
      // systematically undercount each CUA frame by one raster. Keep only the aggregate
      // to avoid maintaining a second text/media accounting state alongside returnedBytes.
      const structuredPayloadBytes = structuredMediaBytes(projectedModelContent);

      // Preserve official CUA image/image_ref atomic pairs unchanged. The bridge applies
      // a separate limit to image bytes, while ordinary text still uses resultBudget so
      // a valid raster cannot bypass the context budget. The early return is coupled to
      // official CUA protection authority; if pair validation fails
      // (protectedProjection is undefined), do not bypass the generic budget.
      return {
        content: projectedContent,
        modelContent: projectedModelContent,
        originalBytes,
        returnedBytes: projectedBytes + structuredPayloadBytes,
        truncated: protectedProjection.truncated,
        budgetStrategy: effectiveBudget.strategy,
        artifactPath: resolvedArtifactPath,
      };
    }
  }

  if (
    (originalBytes <= maxModelBytes && !exceedsCharacterBudget) ||
    // Preserve provider text with a character limit verbatim if persistence fails; do
    // not fall through to generic resultBudget truncation and inject a different notice.
    (exceedsCharacterBudget && shouldPersistArtifact && artifact === undefined)
  ) {
    return {
      content,
      modelContent,
      originalBytes,
      returnedBytes: originalBytes,
      truncated: false,
      budgetStrategy: effectiveBudget.strategy,
      artifactPath: resolvedArtifactPath,
    };
  }

  if (effectiveBudget.strategy === "artifact" && effectiveBudget.artifact?.enabled === true) {
    if (artifact && resolvedArtifactPath) {
      const persistedOutputContent = formatPersistedOutputContent({
        content,
        entry,
        originalBytes,
        output,
        persistedPath: resolvedArtifactPath,
      });
      const persistedContent = stringifyModelContentForSerialization(persistedOutputContent);
      return {
        content: persistedContent,
        modelContent: persistedOutputContent,
        originalBytes,
        returnedBytes: Buffer.byteLength(persistedContent, "utf8"),
        truncated: true,
        budgetStrategy: effectiveBudget.strategy,
        artifactPath: resolvedArtifactPath,
      };
    }
  }

  const artifactHint = resolvedArtifactPath ? `artifactPath=${resolvedArtifactPath}, ` : "";
  const suffix = `\n\n[Tool output truncated by resultBudget: ${artifactHint}originalBytes=${originalBytes}, maxModelBytes=${maxModelBytes}, strategy=${effectiveBudget.strategy}]`;
  const truncatedContent = fitContentWithSuffix(
    content,
    maxModelBytes,
    suffix,
    effectiveBudget.preview?.direction ?? "head",
  );

  return {
    content: truncatedContent,
    modelContent: truncatedContent,
    originalBytes,
    returnedBytes: Buffer.byteLength(truncatedContent, "utf8"),
    truncated: true,
    budgetStrategy: effectiveBudget.strategy,
    artifactPath: resolvedArtifactPath,
  };
}

export function appendHookAdditionalContexts(
  serialization: ToolResultSerialization,
  additionalContexts: string[],
  entry: ToolEntry,
): ToolResultSerialization {
  if (additionalContexts.length === 0) return serialization;
  const filteredAdditionalContexts =
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION
      ? additionalContexts.filter((context) => !containsOfficialCuaImageRefCredentialText(context))
      : additionalContexts;
  const omittedFrameCredential = filteredAdditionalContexts.length !== additionalContexts.length;
  if (filteredAdditionalContexts.length === 0) {
    return omittedFrameCredential ? { ...serialization, truncated: true } : serialization;
  }
  const hookContext = formatHookAdditionalContexts(filteredAdditionalContexts);
  const projected = appendFormattedContextToSerialization(serialization, hookContext, entry);
  return omittedFrameCredential ? { ...projected, truncated: true } : projected;
}

/** Separator written between the tool output and an appended formatted context block. */
export const FORMATTED_CONTEXT_SEPARATOR = "\n\n";

/**
 * Bytes available for one formatted context block appended after `serialization`: the result budget minus what the
 * result already returns, minus the separator. Hook contexts already appended are counted in `returnedBytes`. The
 * caller must keep the block whole when it fits; the appender may cut the block to fit this budget otherwise.
 */
export function resolveFormattedContextBudgetBytes(
  serialization: ToolResultSerialization,
  entry: ToolEntry,
): number {
  const separatorBytes = Buffer.byteLength(FORMATTED_CONTEXT_SEPARATOR, "utf8");
  return Math.max(0, resolveMaxModelBytes(entry) - serialization.returnedBytes - separatorBytes);
}

/**
 * Appends an already-formatted context block to the model-visible result, keeping the result budget, persisted-artifact
 * previews and the official CUA structured-content path. Shared by PostToolUse hook contexts and nested AGENTS.md reminders.
 */
export function appendFormattedContextToSerialization(
  serialization: ToolResultSerialization,
  formattedContext: string,
  entry: ToolEntry,
): ToolResultSerialization {
  const suffix = `${FORMATTED_CONTEXT_SEPARATOR}${formattedContext}`;
  const maxModelBytes = resolveMaxModelBytes(entry);
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION &&
    hasImageBlock(serialization.modelContent ?? serialization.content)
  ) {
    return appendHookWithoutReorderingStructuredContent(
      serialization,
      formattedContext,
      suffix,
      maxModelBytes,
    );
  }
  const previewDirection = entry.resultBudget?.preview?.direction ?? "head";
  const artifactPreview = isPersistedArtifactPreview(serialization);
  const contentProjection = artifactPreview
    ? appendHookToPersistedArtifactPreview(serialization.content, suffix, maxModelBytes)
    : appendHookToStringContent(serialization.content, suffix, maxModelBytes, previewDirection);

  return {
    ...serialization,
    content: contentProjection.content,
    modelContent: projectHookAugmentedModelContent({
      artifactPreview,
      contentProjection,
      hookContext: formattedContext,
      maxModelBytes,
      modelContent: serialization.modelContent ?? serialization.content,
      previewDirection,
      suffix,
    }),
    returnedBytes: Buffer.byteLength(contentProjection.content, "utf8"),
    truncated: serialization.truncated || contentProjection.truncated,
  };
}

function hasImageBlock(content: ModelMessageContent): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some((block) => block.type === "image");
}

/** Actual payload bytes for all image/file blocks in structured content (including dataUrl verbatim). */
function structuredMediaBytes(content: ModelMessageContent): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    if (block.type === "image") return total + Buffer.byteLength(block.dataUrl, "utf8");
    // For file-with-text, the model-visible content is text (the dataUrl is not sent in the request), so it does not count as media bytes.
    if (block.type === "file" && block.dataUrl !== undefined && block.text === undefined)
      return total + Buffer.byteLength(block.dataUrl, "utf8");
    return total;
  }, 0);
}

function resolveMaxModelBytes(entry: ToolEntry): number {
  const budget = entry.resultBudget ?? DEFAULT_RESULT_BUDGET;
  return Math.max(0, Math.min(budget.maxModelBytes, budget.maxInlineBytes));
}

async function tryWriteToolArtifact(
  deps: ToolExecutorDeps,
  content: string,
  contentType: string,
  entry: ToolEntry,
  budget: ToolResultBudget,
  traceContext: TraceContext,
  toolCallId: string,
  signal: AbortSignal,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!deps.artifactStore) {
    return undefined;
  }

  try {
    return await deps.artifactStore.writeToolResultArtifact(
      {
        sessionId: deps.sessionId,
        turnId: traceContext.turnId ?? deps.turnId,
        toolCallId,
        toolName: entry.metadata.name,
        content,
        contentType,
        retention: budget.artifact?.retention ?? "session",
        trace: traceContext,
      },
      { signal },
    );
  } catch {
    // When interacting with the main model, an artifact-write failure should not turn a
    // successful tool call into a failure. Fall back to the shared resultBudget
    // truncation path to keep the result visible without sending the full large output.
    return undefined;
  }
}

function formatPersistedOutputContent(input: {
  content: string;
  entry: ToolEntry;
  originalBytes: number;
  output: unknown;
  persistedPath: string;
}): ModelMessageContent {
  const projected = input.entry.formatPersistedModelContent?.({
    content: input.content,
    originalBytes: input.originalBytes,
    output: input.output,
    persistedPath: input.persistedPath,
  });
  if (projected !== undefined) return projected;

  return formatGenericPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

function isEmptyModelContent(content: ModelMessageContent): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (content.length === 0) return true;
  return content.every((block) => {
    if (block.type !== "text") return false;
    return typeof block.text !== "string" || block.text.trim() === "";
  });
}

function stringifyOutputForModel(output: unknown, entry: ToolEntry): ModelMessageContent {
  if (entry.formatModelContent) return entry.formatModelContent(output);
  if (typeof output === "string") return output;
  if (output === undefined) return "";

  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return String(output);
  }
}

function stringifyModelContentForSerialization(content: ModelMessageContent): string {
  return typeof content === "string" ? content : modelMessageContentToText(content);
}

function isPersistedArtifactPreview(serialization: ToolResultSerialization): boolean {
  return (
    serialization.budgetStrategy === "artifact" &&
    serialization.truncated &&
    typeof serialization.artifactPath === "string" &&
    serialization.artifactPath.length > 0 &&
    isPersistedOutputContent(serialization.content)
  );
}

function findArtifactPath(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  for (const key of ["persistedOutputPath", "rawOutputPath", "artifactPath", "outputPath"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
