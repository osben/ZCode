import { ReadOutputSchema } from "@zcode/contracts";
import { findLatestReadFileState } from "./read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

export const READ_FILE_STATE_METADATA_SCHEMA_VERSION = 1;
// Model-visible result of a Read whose cached view is still fresh. It carries no file body, so the nested AGENTS.md
// history probe must not treat it as the model having seen the file (context/nested-instructions/history.ts).
export const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
// `CreateWorkflow` / `AmendWorkflow` / `FillWorkflowHole`: bytes from an inline draft (or fill file) are the `script` input from the model's call;
// like Write, record them as a complete view (handlers/workflow-draft-read-state.ts).
export type PersistedReadFileStateTool =
  | "Read"
  | "Write"
  | "Edit"
  | "CreateWorkflow"
  | "AmendWorkflow"
  | "FillWorkflowHole";

export interface PersistedReadFileStateMetadata {
  schemaVersion: typeof READ_FILE_STATE_METADATA_SCHEMA_VERSION;
  tool: PersistedReadFileStateTool;
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAtMs: number;
  revisionId: string;
  mtimeMs: number;
  sizeBytes: number;
  /**
   * Sequence number taken by the executor when snapshotting the tool record (in the same
   * synchronous step as the live-state write), i.e. the live write order;
   * compare only within the same assistant. Legacy records lack this field.
   */
  snapshotIndex?: number;
}

export function createReadFileStateMetadata(input: {
  completedAt: Date;
  output: unknown;
  readFileState?: ReadFileStateMap;
  toolInput: unknown;
  toolName: string;
}): PersistedReadFileStateMetadata | undefined {
  if (input.toolName !== "Read") return undefined;

  const parsedOutput = ReadOutputSchema.safeParse(input.output);
  if (!parsedOutput.success) return undefined;
  const output = parsedOutput.data;
  // Only results that actually read content record a snapshot; file_unchanged records nothing (see handlers/read.ts).
  if (output.type !== "text") return undefined;

  const toolInput = asRecord(input.toolInput);
  const offset = toolInput ? numberField(toolInput, "offset") : undefined;
  const limit = toolInput ? numberField(toolInput, "limit") : undefined;
  const latest = findLatestReadFileState(input.readFileState, output.filePath);
  // One entry per file; record it only when it is exactly this request's view, to avoid writing a different view into this metadata.
  const entry =
    latest && (latest.offset ?? 1) === (offset ?? 1) && latest.limit === limit ? latest : undefined;
  return createReadFileStateMetadataFromEntry({
    completedAt: input.completedAt,
    entry,
    toolName: "Read",
  });
}

export function createReadFileStateMetadataFromEntry(input: {
  completedAt: Date;
  entry?: ReadFileStateEntry;
  toolName: PersistedReadFileStateTool;
}): PersistedReadFileStateMetadata | undefined {
  const entry = input.entry;
  if (!entry) return undefined;
  if (entry.mtimeMs === undefined || entry.sizeBytes === undefined || !entry.revisionId) {
    // The resume stale guard must restore the file timestamp and adapter revision;
    // historical file state without freshness metadata must not be treated as read, or it could allow a stale write.
    return undefined;
  }

  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool: input.toolName,
    path: entry.path,
    content: entry.content,
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
    isPartialView: entry.isPartialView,
    readAtMs: input.completedAt.getTime(),
    revisionId: entry.revisionId,
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
  };
}

export function parseReadFileStateMetadata(
  metadata: unknown,
): PersistedReadFileStateMetadata | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const readState = asRecord(record.readFileState);
  if (!readState) return undefined;

  if (readState.schemaVersion !== READ_FILE_STATE_METADATA_SCHEMA_VERSION) return undefined;
  const tool = stringField(readState, "tool");
  if (!isPersistedReadFileStateTool(tool)) return undefined;

  const path = stringField(readState, "path");
  const content = stringField(readState, "content");
  const readAtMs = numberField(readState, "readAtMs");
  const isPartialView = booleanField(readState, "isPartialView");
  const revisionId = stringField(readState, "revisionId");
  const mtimeMs = numberField(readState, "mtimeMs");
  const sizeBytes = numberField(readState, "sizeBytes");
  if (
    !path ||
    content === undefined ||
    readAtMs === undefined ||
    isPartialView === undefined ||
    !revisionId ||
    mtimeMs === undefined ||
    sizeBytes === undefined
  ) {
    return undefined;
  }
  const offset = numberField(readState, "offset");
  const limit = numberField(readState, "limit");
  const snapshotIndex = numberField(readState, "snapshotIndex");

  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool,
    path,
    content,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    isPartialView,
    readAtMs,
    revisionId,
    mtimeMs,
    sizeBytes,
    ...(snapshotIndex === undefined ? {} : { snapshotIndex }),
  };
}

function isPersistedReadFileStateTool(value: unknown): value is PersistedReadFileStateTool {
  return (
    value === "Read" ||
    value === "Write" ||
    value === "Edit" ||
    value === "CreateWorkflow" ||
    value === "AmendWorkflow"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
