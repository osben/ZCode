import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorOutputSchema,
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  CUA_TARGET_APP_DISPLAY_META_KEY,
  cuaTargetAppDisplaySchema,
  nodeReplCuaAppDisplaySchema,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageOutputSchema,
  TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS,
  TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputResultSchema,
  TASK_STOP_TOOL_NAME,
  TaskStopOutputSchema,
  type DiffHunk,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { createBashResultDisplay } from "./bash-result-display.js";
import { countPatchLines } from "../diff.js";
import { boundDisplayText } from "./display-text.js";
import { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

// Preserve the existing exports after moving the builder to create-workflow-display.ts (handlers/create-workflow.ts still imports from here).
export { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { isRecord } from "./utils.js";
import { parseOfficialMcpToolError, type OfficialMcpToolErrorCode } from "@zcode/shared";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "@zcode/zcode-cua/request-access-contract";

const MAX_DISPLAY_DIFF_HUNKS = 8;
const MAX_DISPLAY_DIFF_LINES = 160;
const MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES = 4 * 1024;
const MAX_TASK_STOP_DISPLAY_FIELD_BYTES = 16 * 1024;
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

export function createMcpToolDisplay(
  metadata:
    | {
        serverName: string;
        toolName: string;
        description?: string;
        official?: boolean;
      }
    | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  const unavailable = metadata.official ? readOfficialMcpUnavailable(output) : undefined;
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
    ...(unavailable ? { unavailable } : {}),
  };
}

/**
 * When quota is exhausted or no Coding Plan is available, the official Server MCP
 * renders a structured identifier in the JSON text of tool error content (server-side
 * `ToolError.Error()`). Read only that identifier here; do not parse ordinary error text.
 *
 * This path runs only when `metadata.official` is true, and that flag is set only for
 * **HTTP** official MCP, whose response comes from a ZCode backend with a validated
 * origin. Ignore the same payload from stdio official MCP and third-party MCPs: their
 * results come from plugin processes, which could forge a Coding Plan message to mislead
 * users into purchasing one.
 */
function readOfficialMcpUnavailable(
  output: unknown,
): { code: OfficialMcpToolErrorCode } | undefined {
  if (!isRecord(output) || output.isError !== true || !Array.isArray(output.content)) {
    return undefined;
  }
  for (const block of output.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const parsed = parseOfficialMcpToolError(block.text);
    if (parsed) return { code: parsed.code };
  }
  return undefined;
}

export function createToolResultDisplay(
  toolName: string,
  output: unknown,
  options?: {
    officialCua?: boolean;
    mcp?: {
      serverName: string;
      toolName: string;
      description?: string;
      official?: boolean;
    };
  },
): ToolResultDisplayPayload | undefined {
  if (toolName === "Bash") return createBashResultDisplay(output);

  const cuaToolName = readCuaToolName(toolName);
  if (cuaToolName) {
    return createCuaToolResultDisplay(cuaToolName, output, options?.officialCua === true);
  }

  const nodeReplDisplay = createNodeReplDisplay(toolName, output);
  if (nodeReplDisplay) return nodeReplDisplay;

  const createWorkflow = createCreateWorkflowDisplay(toolName, output);
  if (createWorkflow) return createWorkflow;

  const workflowObservation = createWorkflowObservationDisplay(toolName, output);
  if (workflowObservation) return workflowObservation;

  if (options?.mcp) {
    // Build from the result: the official MCP unavailability identifier is available only in this result, so pass output too.
    return createMcpToolDisplay(options.mcp, output);
  }

  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    const parsed = SendMessageOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    // Display bypasses the tool-result budget and must be bounded separately before entering live events and persisted metadata.
    const error =
      parsed.data.error === undefined
        ? undefined
        : boundDisplayText(parsed.data.error, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    const message =
      parsed.data.message === undefined
        ? undefined
        : boundDisplayText(parsed.data.message, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    return {
      kind: "local_agent_message",
      status: parsed.data.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (toolName === TASK_STOP_TOOL_NAME) {
    const parsed = TaskStopOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const command =
      parsed.data.command === undefined
        ? undefined
        : boundDisplayText(parsed.data.command, MAX_TASK_STOP_DISPLAY_FIELD_BYTES);
    const message = boundDisplayText(
      compactTaskStopDisplayMessage(parsed.data),
      MAX_TASK_STOP_DISPLAY_FIELD_BYTES,
    );
    const truncated = command?.truncated === true || message.truncated;
    return {
      kind: "task_stop",
      taskId: parsed.data.task_id,
      taskType: parsed.data.task_type,
      ...(command !== undefined ? { command: command.value } : {}),
      message: message.value,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === TASK_OUTPUT_TOOL_NAME) {
    const parsed = TaskOutputResultSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const taskStatus = parsed.data.task?.status
      .trim()
      .slice(0, TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS);
    const fullOutput = parsed.data.task?.output.trimEnd();
    const hasOutput = fullOutput !== undefined && fullOutput.trim().length > 0;
    const truncated = hasOutput && fullOutput.length > TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS;

    // UI display is a bounded projection separate from provider content; do not put the
    // full TaskOutput XML or result object in live events or persisted metadata.
    return {
      kind: "task_output",
      retrievalStatus: parsed.data.retrieval_status,
      ...(taskStatus ? { taskStatus } : {}),
      ...(hasOutput ? { output: fullOutput.slice(0, TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === RESPOND_TO_COORDINATOR_TOOL_NAME) {
    const parsed = RespondToCoordinatorOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    return {
      kind: "respond_to_coordinator",
      status: parsed.data.status,
    };
  }

  if (!isRecord(output)) return undefined;
  const filePath = output.filePath;
  const structuredPatch = output.structuredPatch;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) {
    return undefined;
  }

  const hunks = structuredPatch.filter(isDiffHunk);
  if (hunks.length === 0) return undefined;

  const { additions, deletions } = countPatchLines(hunks);
  const { patch: boundedPatch, truncated } = boundDiffHunks(hunks);
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: boundedPatch,
    truncated,
  };
}

function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery is external input. A direct slice may split a UTF-16 surrogate pair
  // and produce a string that cannot be serialized consistently across events,
  // persistence, and replayable snapshots. If the boundary follows a high surrogate,
  // drop the partial character so display remains safe to serialize.
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

const MAX_CUA_DISPLAY_FIELD_BYTES = 32 * 1024;
const MAX_CUA_INLINE_MEDIA_BYTES = 256 * 1024;
const MAX_CUA_INLINE_MEDIA_TOTAL_BYTES = 512 * 1024;

function readCuaToolName(toolName: string): string | undefined {
  // Support both CUA tool naming forms: direct `mcp__computer_use__<action>` and the
  // plugin namespace form `mcp__plugin_zcode-cua_computer-use__<action>`. After
  // normalization (lowercase and `-` → `_`), the name contains `computer_use`, and the
  // action is the substring after the last `__`.
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized.includes("computer_use")) return undefined;
  const lastSep = normalized.lastIndexOf("__");
  if (lastSep === -1) return undefined;
  const action = normalized.slice(lastSep + "__".length);
  return action.length > 0 ? action : undefined;
}

function createCuaToolResultDisplay(
  toolName: string,
  output: unknown,
  officialCua: boolean,
): ToolResultDisplayPayload {
  const result = isRecord(output) ? output : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const structuredContent = result.structuredContent;
  const structuredRecord = isRecord(structuredContent) ? structuredContent : undefined;
  const errorRecord = isRecord(structuredRecord?.error) ? structuredRecord.error : undefined;
  const structuredJson =
    structuredContent === undefined
      ? undefined
      : boundDisplayText(safeJson(structuredContent), MAX_CUA_DISPLAY_FIELD_BYTES);
  const boundedText = text ? boundDisplayText(text, MAX_CUA_DISPLAY_FIELD_BYTES) : undefined;
  // Artifact URIs are readable only on the Agent's machine; projecting them directly
  // would send media that other UI clients cannot render. Until a controlled read API
  // exists, display carries only inline images that can be rendered directly.
  const media: Array<{ mimeType: string; data: string }> = [];
  let inlineMediaBytes = 0;
  let mediaTruncated = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    let projectedMedia: { mimeType: string; data: string } | undefined;
    let decodedBytes = 0;
    if (
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      decodedBytes = Buffer.byteLength(item.data, "base64");
      projectedMedia = { mimeType: item.mimeType, data: item.data };
    }
    if (!projectedMedia) continue;
    // The media quota applies only to actual media; leading text blocks must not consume the screenshot slot.
    if (media.length >= 4) {
      mediaTruncated = true;
      break;
    }
    if (
      decodedBytes > MAX_CUA_INLINE_MEDIA_BYTES ||
      inlineMediaBytes + decodedBytes > MAX_CUA_INLINE_MEDIA_TOTAL_BYTES
    ) {
      mediaTruncated = true;
      continue;
    }
    inlineMediaBytes += decodedBytes;
    media.push(projectedMedia);
  }
  const truncated =
    mediaTruncated || structuredJson?.truncated === true || boundedText?.truncated === true;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const targetApp = officialCua
    ? cuaTargetAppDisplaySchema.safeParse(meta?.[CUA_TARGET_APP_DISPLAY_META_KEY])
    : undefined;
  const permissionStatus =
    officialCua && toolName === "request_access"
      ? cuaRequestAccessStatusSchema.safeParse(meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY])
      : undefined;

  // MCP modelContent flattens structuredContent into text. Build a separate, bounded
  // display before flattening so live events and session history can consistently
  // distinguish CUA errors from structured results.
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName,
    status: result.isError === true ? "failed" : "success",
    ...(structuredJson ? { structuredContent: structuredJson.value } : {}),
    ...(boundedText ? { text: boundedText.value } : {}),
    ...(typeof errorRecord?.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord?.suggested_action === "string"
      ? { suggestedAction: errorRecord.suggested_action }
      : {}),
    ...(targetApp?.success ? { targetApp: targetApp.data } : {}),
    ...(permissionStatus?.success ? { permissionStatus: permissionStatus.data } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

/**
 * Read the host-written identity of the CUA target application.
 *
 * Accept only `zcode/nodeReplCuaApp`. A producer's `zcode.cua/app-associations-v1` may
 * also appear in `_meta`, but that key can be supplied through model-writable
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult`; the host removes it in
 * toMcpRunResult. Do not add a second fallback parser here, which could reconnect an
 * already untrusted source to the display.
 */
function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    images.push({ base64, mimeType });
  }

  // Action-only cells (click, input) have no screenshot, but still need to project the
  // App identity to the tool card's leading icon. An image cannot be the only condition
  // for producing display.
  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function compactTaskStopDisplayMessage(output: {
  command?: string;
  message: string;
  task_id: string;
}): string {
  if (output.command === undefined) {
    return output.message;
  }

  // TaskStop's standard success message repeats the command in parentheses. Display
  // already has a separate command field, so keep only the stop outcome in the result row.
  const standardMessage = `Successfully stopped task: ${output.task_id} (${output.command})`;
  return output.message === standardMessage
    ? `Successfully stopped task: ${output.task_id}`
    : output.message;
}

function isDiffHunk(value: unknown): value is DiffHunk {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {
  const bounded: DiffHunk[] = [];
  let remainingLines = MAX_DISPLAY_DIFF_LINES;
  let truncated = hunks.length > MAX_DISPLAY_DIFF_HUNKS;

  for (const hunk of hunks.slice(0, MAX_DISPLAY_DIFF_HUNKS)) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const lines = hunk.lines.slice(0, remainingLines);
    bounded.push({ ...hunk, lines });
    remainingLines -= lines.length;
    if (lines.length < hunk.lines.length) {
      truncated = true;
      break;
    }
  }

  return { patch: bounded, truncated };
}
