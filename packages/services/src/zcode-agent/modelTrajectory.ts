import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ZCodeModelTrajectory,
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "#src/session/zcodeTaskService.js";

export type {
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryTruncation,
  ZCodeModelTrajectoryUsage,
} from "#src/session/zcodeTaskService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  boundPayload,
  boundText,
  readTrajectoryFileTail,
  resolveModelIODirs,
  sanitizeSessionSegment,
  withTruncation,
} from "#src/zcode-agent/modelTrajectoryFileTail.js";
import type { TrajectoryFileTail } from "#src/zcode-agent/modelTrajectoryFileTail.js";

// Maximum number of model-io calls returned by default (keep the latest N) to avoid overwhelming the UI with long sessions.
const DEFAULT_TRAJECTORY_LIMIT = 200;
const SESSION_TITLE_PROMPT_PREFIX = "Generate a concise title for this coding session.";
const logger = createServiceLogger("model-trajectory");

/**
 * Parse model-io JSONL under ~/.zcode/cli/{debug,rollout} and reconstruct a task's model-call trajectory by sessionId.
 *
 * Design notes:
 * - model-io is written by adapters/model/runner-debug.ts, with one
 *   `model-io-<sanitizedSessionId>.jsonl` file per session.
 * - ZCode Agent uses taskId as sessionId (see zcodeTaskServiceAdapter), so read only
 *   that session's file and match exactly with `record.sessionId === taskId`.
 */
export async function readModelTrajectory(
  taskId: string,
  limit = DEFAULT_TRAJECTORY_LIMIT,
): Promise<ZCodeModelTrajectory> {
  const window = await readModelIORawWindow(taskId, limit);
  // Input deltas are decided on the projected window only, so the first main record in the window is always full.
  const trimmedRecords = projectModelTrajectoryInputDeltas(
    window.records.map((record) => mapModelTrajectoryRecord(record)),
  );

  return {
    taskId,
    available: true,
    records: trimmedRecords,
    sourceFiles: window.sourceFiles,
    truncated: window.truncated,
  };
}

/** Kept raw model-io records after writer-delta expansion, oldest first. */
export interface ModelIORawWindow {
  records: Record<string, unknown>[];
  sourceFiles: string[];
  truncated: boolean;
}

export async function readModelIORawWindow(
  taskId: string,
  limit = DEFAULT_TRAJECTORY_LIMIT,
): Promise<ModelIORawWindow> {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_TRAJECTORY_LIMIT;
  const sanitized = sanitizeSessionSegment(taskId);
  const dirs = resolveModelIODirs();
  const sourceFiles: string[] = [];
  const rawRecords: Record<string, unknown>[] = [];
  let inputTruncated = false;

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // Skip if the directory does not exist (the mode has not run) or is unreadable.
      continue;
    }

    const fileName = `model-io-${sanitized || "no-session"}.jsonl`;
    const candidates = names.includes(fileName) ? [fileName] : [];

    for (const name of candidates) {
      const filePath = join(dir, name);
      let tail: TrajectoryFileTail;
      const startedAt = Date.now();
      try {
        // Synchronously reading and splitting the entire model-io file would block the Host event loop and create several peak string copies for large files.
        // Read a fixed limit asynchronously from the end; if reading begins in the middle of a line, readTrajectoryFileTail discards the incomplete line.
        tail = await readTrajectoryFileTail(filePath);
        logger.debug(
          undefined,
          `read taskId=${taskId} bytes=${tail.bytesRead} truncated=${tail.truncated} durationMs=${Date.now() - startedAt}`,
        );
      } catch (error) {
        logger.debug(undefined, `read failed taskId=${taskId} file=${filePath}`, error);
        continue;
      }
      inputTruncated ||= tail.truncated;

      let matchedInFile = false;
      for (const line of tail.text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.type !== "model_io" || parsed.sessionId !== taskId) {
          continue;
        }
        rawRecords.push(parsed);
        matchedInFile = true;
      }

      if (matchedInFile) {
        sourceFiles.push(filePath);
      }
    }
  }

  // Sort by start time; use requestId as a fallback for equal/missing timestamps to keep ordering stable.
  rawRecords.sort((left, right) => {
    const startDiff = toTime(asString(left.startedAt)) - toTime(asString(right.startedAt));
    if (startDiff !== 0) {
      return startDiff;
    }
    return (asString(left.requestId) ?? "").localeCompare(asString(right.requestId) ?? "");
  });

  // Delta expansion must run over every raw record in order; projection (the costly part) runs only on the kept tail.
  const expanded = expandModelIODeltaRecords(rawRecords);
  const truncated = inputTruncated || expanded.length > safeLimit;
  const kept = truncated ? expanded.slice(expanded.length - safeLimit) : expanded;
  return { records: kept, sourceFiles, truncated };
}

interface InputDeltaBase {
  requestId: string;
  length: number;
  identities: string[];
}

/**
 * Replace a main-session record's full input with the messages after the nearest preceding main record's input when
 * that whole input is an exact prefix (message by message, role and parts, serialized after bounding).
 * Sidecar, compact and subagent records are always full and never serve as a base; the first main record has no base.
 */
export function projectModelTrajectoryInputDeltas(
  records: ZCodeModelTrajectoryRecord[],
): ZCodeModelTrajectoryRecord[] {
  let base: InputDeltaBase | undefined;
  return records.map((record) => {
    if (record.callSource?.kind !== "main") {
      return record;
    }
    const messages = record.request.messages;
    const identities = messages.map((message) => JSON.stringify(message));
    const previous = base;
    base = record.requestId
      ? { requestId: record.requestId, length: messages.length, identities }
      : undefined;
    if (!previous || !isExactPrefix(previous.identities, identities)) {
      return record;
    }
    return {
      ...record,
      inputDeltaOf: { previousRequestId: previous.requestId, sharedPrefixCount: previous.length },
      request: { ...record.request, messages: messages.slice(previous.length) },
    };
  });
}

function isExactPrefix(prefix: readonly string[], values: readonly string[]): boolean {
  if (prefix.length > values.length) {
    return false;
  }
  return prefix.every((identity, index) => identity === values[index]);
}

function toTime(value?: string): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function mapModelTrajectoryRecord(
  record: Record<string, unknown>,
): ZCodeModelTrajectoryRecord {
  const request = asObject(record.request);
  const response = asObject(record.response);
  const model = asObject(record.model);
  const error = asObject(record.error);
  const querySource = asString(record.querySource) ?? inferQuerySourceFromRequest(request);
  const modelRole = asString(model?.role);

  const mapped: ZCodeModelTrajectoryRecord = {
    requestId: asString(record.requestId) ?? "",
    attempt: asNumber(record.attempt) ?? 1,
    startedAt: asString(record.startedAt) ?? "",
    completedAt: asString(record.completedAt),
    durationMs: asNumber(record.durationMs),
    turnId: asString(record.turnId),
    traceId: asString(record.traceId),
    callSource: classifyCallSource(querySource, modelRole),
    model: {
      modelId: asString(model?.modelId),
      providerId: asString(model?.providerId),
      role: modelRole,
      source: asString(model?.source),
    },
    request: {
      messages: mapMessages(request?.messages),
      toolNames: asStringArray(request?.toolNames),
    },
  };

  if (response) {
    const responseToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const responseText = asString(response.text);
    const responseReasoning = asString(response.reasoningText);
    const text = responseText === undefined ? undefined : boundText(responseText);
    const reasoningText =
      responseReasoning === undefined ? undefined : boundText(responseReasoning);
    const responseTruncated =
      text?.truncated || reasoningText?.truncated
        ? {
            ...(text?.truncated ? { text: text.truncated } : {}),
            ...(reasoningText?.truncated ? { reasoningText: reasoningText.truncated } : {}),
          }
        : undefined;
    mapped.response = {
      finishReason: asString(response.finishReason),
      text: text?.text,
      reasoningText: reasoningText?.text,
      toolCalls: responseToolCalls.map((toolCall) => mapResponseToolCall(toolCall)),
      ...(responseTruncated ? { truncated: responseTruncated } : {}),
      usage: mapUsage(response.usage),
      responseId: asString(response.responseId),
      modelId: asString(response.modelId),
    };
  }

  if (error && (asString(error.message) || asString(error.name))) {
    mapped.error = {
      name: asString(error.name) ?? "Error",
      message: asString(error.message) ?? "",
      stack: asString(error.stack),
    };
  }

  return mapped;
}

function inferQuerySourceFromRequest(
  request: Record<string, unknown> | undefined,
): string | undefined {
  const messages = request?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const first = asObject(messages[0]);
  if (first?.role !== "system") {
    return undefined;
  }
  const content = asString(first.content);
  return content?.startsWith(SESSION_TITLE_PROMPT_PREFIX) ? "session_title" : undefined;
}

function classifyCallSource(
  querySource: string | undefined,
  modelRole: string | undefined,
): ZCodeModelTrajectoryCallSource {
  if (querySource === "main_turn") {
    return { kind: "main", querySource };
  }
  if (querySource === "subagent") {
    return { kind: "subagent", querySource };
  }
  if (querySource === "compact" || modelRole === "compact") {
    return { kind: "compact", querySource };
  }
  if (querySource) {
    return { kind: "sidecar", querySource };
  }
  if (modelRole === "subagent") {
    return { kind: "subagent" };
  }
  return { kind: "main" };
}

function expandModelIODeltaRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];
  let previous: Record<string, unknown> | undefined;
  for (const record of records) {
    const next = expandModelIORecord(record, previous);
    expanded.push(next);
    previous = next;
  }
  return expanded;
}

function expandModelIORecord(
  record: Record<string, unknown>,
  previousRecord?: Record<string, unknown>,
): Record<string, unknown> {
  const request = asObject(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: expandModelIORequest(request, asObject(previousRecord?.request)),
  };
}

function expandModelIORequest(
  request: Record<string, unknown>,
  previousRequest?: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...request };
  expandMessageCollection(next, previousRequest, {
    collectionKey: "messages",
    kindKey: "messagesKind",
    offsetKey: "messageOffset",
  });
  expandMessageCollection(next, previousRequest, {
    collectionKey: "sdkMessages",
    kindKey: "sdkMessagesKind",
    offsetKey: "sdkMessageOffset",
  });

  const body = asObject(next.body);
  if (body) {
    const nextBody = { ...body };
    expandMessageCollection(
      nextBody,
      asObject(previousRequest?.body),
      {
        collectionKey: "messages",
        kindKey: "bodyMessagesKind",
        offsetKey: "bodyMessageOffset",
      },
      next,
    );
    next.body = nextBody;
  }

  return next;
}

function expandMessageCollection(
  target: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  keys: {
    collectionKey: string;
    kindKey: string;
    offsetKey: string;
  },
  metadataSource: Record<string, unknown> = target,
): void {
  if (metadataSource[keys.kindKey] === "tail") {
    // A recent-window baseline is written when the model-io file exceeds its limit or its in-process cache is lost.
    // The tail is the new expansion starting point; do not append earlier history or the trimmed large context would return to the UI read path.
    return;
  }
  if (metadataSource[keys.kindKey] !== "delta") {
    return;
  }
  const deltaMessages = target[keys.collectionKey];
  const previousMessages = previous?.[keys.collectionKey];
  const offset = asNonNegativeInteger(metadataSource[keys.offsetKey]);
  if (!Array.isArray(deltaMessages) || !Array.isArray(previousMessages) || offset === undefined) {
    return;
  }
  // New model-io stores only deltas to avoid duplicating the full context across a session; restore it for the UI when reading in the service layer.
  target[keys.collectionKey] = [...previousMessages.slice(0, offset), ...deltaMessages];
}

function mapMessages(value: unknown): ZCodeModelTrajectoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const message = asObject(entry) ?? {};
    const role = asString(message.role) ?? "unknown";
    const parts = mapContent(message.content, role, {
      toolCallId:
        asString(message.toolCallId) ??
        asString(message.tool_call_id) ??
        asString(message.tool_use_id),
      toolName: asString(message.toolName) ?? asString(message.name),
      isError: message.isError === true || message.is_error === true,
    });
    // Normalized model-io keeps assistant tool calls in a top-level `toolCalls` array, not in content;
    // mapping content alone dropped every historical call and left its tool results orphaned.
    if (role === "assistant" && Array.isArray(message.toolCalls)) {
      parts.push(...message.toolCalls.map((toolCall) => mapResponseToolCall(toolCall)));
    }
    return { role, parts };
  });
}

function mapContent(
  content: unknown,
  role?: string,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart[] {
  if (typeof content === "string") {
    if (content.length === 0) return [];
    // String content with the tool role is tool output; mark it separately as tool-result so the UI can distinguish it.
    if (role === "tool") {
      const bounded = boundText(content);
      // The actual model-io stores association fields at the message top level and keeps only the string result in content;
      // dropping the top-level fields would prevent the UI from associating TOOL output with the corresponding tool call.
      return [
        withTruncation(
          {
            kind: "tool-result",
            toolCallId: messageTool?.toolCallId,
            toolName: messageTool?.toolName,
            // Normalized model-io flattens error-text into content + isError; restore the type here,
            // or the UI will see only an error string and cannot show the error state.
            // A cut string is not parsed as JSON: the cut would make the parse fail and the structure is no longer complete anyway.
            output: bounded.truncated
              ? messageTool?.isError
                ? { type: "error-text", value: bounded.text }
                : bounded.text
              : tryParseJson(content, messageTool?.isError),
          },
          bounded.truncated,
        ),
      ];
    }
    const bounded = boundText(content);
    return [withTruncation({ kind: "text", text: bounded.text }, bounded.truncated)];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((rawPart) => mapPart(rawPart, role === "tool" ? messageTool : undefined));
}

function mapPart(
  rawPart: unknown,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart {
  const part = asObject(rawPart);
  if (!part) {
    return mapUnknownPart(rawPart);
  }

  switch (part.type) {
    case "text": {
      const bounded = boundText(asString(part.text) ?? "");
      return withTruncation({ kind: "text", text: bounded.text }, bounded.truncated);
    }
    case "reasoning": {
      const bounded = boundText(asString(part.text) ?? "");
      return withTruncation({ kind: "reasoning", text: bounded.text }, bounded.truncated);
    }
    case "tool-call": {
      const input = boundPayload(part.input ?? part.args);
      return withTruncation(
        {
          kind: "tool-call",
          toolCallId: asString(part.toolCallId),
          toolName: asString(part.toolName) ?? "tool",
          input: input.value,
        },
        input.truncated,
      );
    }
    case "tool-result": {
      const output = boundPayload(part.output ?? part.result);
      return withTruncation(
        {
          kind: "tool-result",
          toolCallId: asString(part.toolCallId) ?? messageTool?.toolCallId,
          toolName: asString(part.toolName) ?? messageTool?.toolName,
          output: output.value,
        },
        output.truncated,
      );
    }
    case "image":
    case "file":
      return { kind: "image", mediaType: asString(part.mediaType) };
    default:
      return mapUnknownPart(rawPart);
  }
}

function mapUnknownPart(raw: unknown): ZCodeModelTrajectoryContentPart {
  const bounded = boundPayload(raw);
  return withTruncation({ kind: "unknown", raw: bounded.value }, bounded.truncated);
}

function mapResponseToolCall(rawToolCall: unknown): ZCodeModelTrajectoryContentPart {
  const toolCall = asObject(rawToolCall);
  if (!toolCall) {
    return mapUnknownPart(rawToolCall);
  }
  const input = boundPayload(toolCall.input ?? toolCall.args);
  return withTruncation(
    {
      kind: "tool-call",
      // Normalized response.toolCalls have the shape {id, name, input}.
      toolCallId: asString(toolCall.id) ?? asString(toolCall.toolCallId),
      toolName: asString(toolCall.name) ?? asString(toolCall.toolName) ?? "tool",
      input: input.value,
    },
    input.truncated,
  );
}

function mapUsage(value: unknown): ZCodeModelTrajectoryUsage | undefined {
  const usage = asObject(value);
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    totalTokens: asNumber(usage.totalTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    reasoningTokens: asNumber(usage.reasoningTokens),
  };
}

function tryParseJson(value: string, isError = false): unknown {
  if (isError) return { type: "error-text", value };
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
