/* oxlint-disable eslint(max-lines) -- Claude native log parsing must keep user-turn handling, assistant recovery, and system-warning attribution together; splitting it would scatter the semantics of one log format. */
import { stat } from "node:fs/promises";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { readJsonLinesFile } from "#src/session/claude-native/sessionHistoryJsonl.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";

const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
const COMMAND_TAG_BLOCK_RE =
  /<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toTimestampMs(numericValue);
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readEntryTimestamp(entry: JsonLineRecord): number | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  const candidates = [
    entry.timestamp,
    entry.createdAt,
    entry.updatedAt,
    entry.created_at,
    entry.updated_at,
    entry.time,
    message?.timestamp,
    message?.createdAt,
    message?.updatedAt,
    request?.timestamp,
  ];

  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return undefined;
}

function readEntryWorkspacePath(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    readTrimmedString(entry.cwd) ??
    readTrimmedString(message?.cwd) ??
    readTrimmedString(request?.cwd)
  );
}

function readEntryModel(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return readTrimmedString(entry.model) ?? readTrimmedString(message?.model);
}

function isClaudeNativeSidechainEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    entry.isSidechain === true || message?.isSidechain === true || request?.isSidechain === true
  );
}

export function hasClaudeNativeSidechainMarker(entries: readonly JsonLineRecord[]): boolean {
  return entries.some(isClaudeNativeSidechainEntry);
}

function sanitizeClaudeVisibleText(text: string): string {
  return text
    .replace(IDE_OPENED_FILE_TAG_RE, " ")
    .replace(COMMAND_TAG_BLOCK_RE, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function stripClaudeNativeSyntheticNoResponsePlaceholderText(text: string): string {
  return text
    .trimEnd()
    .replace(/(?:\n+\s*)?No response requested\.$/u, "")
    .trimEnd();
}

function isClaudeNativeSyntheticPlaceholderEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  // Claude Code also writes SDK-generated control placeholders as assistant messages,
  // such as "No response requested." with model=<synthetic>. These placeholders have no user-visible value,
  // but API Error/login errors are assistant bubbles the user sees in Claude and must be preserved during import.
  return (
    readEntryModel(entry) === "<synthetic>" &&
    entry.isApiErrorMessage !== true &&
    message?.isApiErrorMessage !== true
  );
}

function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isObjectRecord(value)) {
    return "";
  }

  return readTrimmedString(value.text) ?? readTrimmedString(value.content) ?? "";
}

function extractClaudeUserText(entry: JsonLineRecord): string | null {
  if (entry.type !== "user") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (entry.isMeta === true || message?.isMeta === true) {
    return null;
  }

  // Important business logic: extract only problem text actually visible to the user.
  // tool_result / local-command / ide_opened_file may also appear in native Claude logs,
  // but these are protocol noise or IDE-injected information; writing them into a zcode task would distort the imported conversation.
  const content =
    message?.content ?? (isObjectRecord(entry.request) ? entry.request.prompt : undefined);
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type === "tool_result") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractClaudeAssistantText(entry: JsonLineRecord): string | null {
  if (entry.type !== "assistant") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (isClaudeNativeSyntheticPlaceholderEntry(entry)) {
    return null;
  }

  const content = message?.content;
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type !== "text") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  const text = parts.length > 0 ? parts.join("") : "";
  if (!text) {
    return null;
  }
  const visibleText = stripClaudeNativeSyntheticNoResponsePlaceholderText(text);
  return visibleText.length > 0 ? visibleText : null;
}

export function extractClaudeNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
  let workspacePath: string | undefined;

  for (const entry of entries) {
    const userText = extractClaudeUserText(entry);
    const assistantText = extractClaudeAssistantText(entry);
    // During scanning, do not determine the workspace from the cwd of an arbitrary header event,
    // because preceding queue/progress records may carry a deeper temporary cwd.
    // Wait until the first genuinely visible business message before treating its cwd as the session's workspace.
    if (!workspacePath && (userText || assistantText)) {
      workspacePath = readEntryWorkspacePath(entry);
    }
    if (!userText) {
      continue;
    }

    return {
      workspacePath,
      previewTitle: deriveSessionTitle(userText, []),
      createdAt: readEntryTimestamp(entry),
    };
  }

  return { workspacePath };
}

function parseClaudeNativeSessionRecords(params: {
  records: readonly JsonLineRecord[];
  workspacePath: string;
  sessionId: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): ClaudeNativeImportedSessionSource {
  const messages: ClaudeNativeImportedSessionSource["messages"] = [];
  let detectedWorkspacePath: string | undefined;
  let firstVisibleUserTimestamp: number | undefined;
  let updatedAt = params.fallbackUpdatedAt;
  let currentTurnIndex = -1;
  let model: string | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }

    // Important business logic: one assistant response in a native Claude log may be split into multiple events.
    // Aggregate them when the next visible user turn arrives or the file ends so imported history
    // remains the smallest renderable structure: one user turn plus one assistant turn.
    messages.push({
      role: "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTimestamp ?? updatedAt ?? Date.now(),
      ...(model ? { model } : {}),
      turnIndex: currentTurnIndex,
    });
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of params.records) {
    const userText = extractClaudeUserText(entry);
    if (!detectedWorkspacePath && userText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      const timestamp = readEntryTimestamp(entry) ?? updatedAt ?? Date.now();
      // Prefer the first visible user message for createdAt over the file birthtime.
      // A native jsonl file's creation time may only indicate when it was written to disk and does not reliably represent when the user started the session.
      firstVisibleUserTimestamp ??= timestamp;
      updatedAt = timestamp;
      messages.push({
        role: "user",
        content: userText,
        timestamp,
        turnIndex: currentTurnIndex,
      });
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!detectedWorkspacePath && assistantText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    // Synthetic/API error assistant messages are filtered from the body, but may also have
    // model=<synthetic>. The imported snapshot's model must come from a visible model response; otherwise, a follow-up would treat
    // the SDK placeholder model as real when making session/load and set_model decisions.
    model ??= readEntryModel(entry);
    pendingAssistantContent += assistantText;
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp ?? updatedAt;
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(`[claude-native] Claude 原生 session ${params.sessionId} 没有可导入的可见消息`);
  }

  return {
    provider: "claude",
    sessionId: params.sessionId,
    workspacePath: detectedWorkspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
    createdAt: firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? Date.now(),
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
    // Important business logic: provider=claude only indicates that Claude will continue the task;
    // it cannot distinguish a Claude task created in zcode from one migrated from native Claude Code history.
    // Write migrationSource separately so task lists/statistics can reliably identify the migration source later.
    migrationSource: "claudeCode",
    ...(model ? { model } : {}),
    messages,
  };
}

export async function parseClaudeNativeSessionFile(params: {
  filePath: string;
  workspacePath: string;
  sessionId: string;
  sourcePath?: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ClaudeNativeImportedSessionSource> {
  const [records, sourceStat] = await Promise.all([
    readJsonLinesFile(params.filePath),
    stat(params.filePath),
  ]);

  return parseClaudeNativeSessionRecords({
    records,
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    sourcePath: params.sourcePath ?? params.filePath,
    fallbackCreatedAt: params.fallbackCreatedAt ?? Math.trunc(sourceStat.birthtimeMs),
    fallbackUpdatedAt: params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs),
  });
}
