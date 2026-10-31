import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  ToolPart,
} from "@zcode/contracts";
import {
  parseReadFileStateMetadata,
  type PersistedReadFileStateMetadata,
  type PersistedReadFileStateTool,
} from "../tool/read-file-state-metadata.js";
import { READ_FILE_UNCHANGED_STUB } from "../tool/handlers/read-text.js";
import {
  normalizeReadFileStateMtimeMs,
  requestedPathField,
  setReadFileStateEntry,
} from "../tool/read-file-state.js";
import type { ReadFileStateMap } from "../tool/types.js";
import { activeSessionMessages } from "./session-history-hydrator.js";

export interface ReadFileStateHydrationResult {
  restoredCount: number;
  skippedUnreadableEditCount: number;
}

type CompletedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    output: unknown;
    status: "completed";
  };
};

export async function hydrateReadFileStateFromSession(input: {
  branchCutAfterMessageId?: MessageId;
  messages: MessageWithParts[];
  /**
   * resume passes true: restored records carry restoredFromSession, and compaction backfill
   * sorts them by read time. rewind rebuilds in the same process and omits it, sorting by
   * mtime like live records.
   */
  markRestoredFromSession?: boolean;
  readFileState: ReadFileStateMap;
  /** rewind passes true: keep records written by context at session start; resume rewrites them via context initialization. */
  retainContextSeeds?: boolean;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<ReadFileStateHydrationResult> {
  // Bug cause: clearing the whole table on rewind dropped MEMORY.md's context record, and
  // rewind does not reload context, so a later Write MEMORY.md reported the file as unread.
  // When the rewound segment read or wrote it, the record was already overwritten by tool
  // records and is cleared as usual.
  for (const [key, entry] of input.readFileState) {
    if (!(input.retainContextSeeds && entry.seededFromContext)) input.readFileState.delete(key);
  }
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });

  const result: ReadFileStateHydrationResult = {
    restoredCount: 0,
    skippedUnreadableEditCount: 0,
  };

  for (const message of activeMessages) {
    if (message.info.role !== "assistant") continue;

    for (const snapshot of inSnapshotOrder(dedupeParts(message.parts))) {
      if (restoreSnapshot(input.readFileState, snapshot, input.markRestoredFromSession)) {
        result.restoredCount++;
      }
    }
  }

  return result;
}

// Range reads restore like same-runtime: overwrite in live's update order, keeping the most
// recent view per file.
// Bug cause: restoring only full reads made "full → range → restart → full" hit the stale full
// view and return Wasted call while live returned the body; the same history gave different
// results before and after restart.
// Write / Edit and inline drafts (bytes the model wrote itself) restore only the full snapshot
// persisted on success: resume must not read the current disk to "complete" the state, or an
// external manual save would be miscounted as read by the agent.
function restoreSnapshot(
  readFileState: ReadFileStateMap,
  { requestedPath, snapshot }: RestorableSnapshot,
  markRestoredFromSession: boolean | undefined,
): boolean {
  const fullWindow = isHistoricalFullReadWindow(snapshot);
  if (snapshot.tool !== "Read" && !fullWindow) return false;
  setReadState(readFileState, snapshot.path, snapshot.content, {
    isPartialView: snapshot.isPartialView,
    ...requestedPathField(requestedPath, snapshot.path),
    ...(fullWindow ? {} : { offset: snapshot.offset, limit: snapshot.limit }),
    mtimeMs: normalizeReadFileStateMtimeMs(snapshot.mtimeMs),
    readAt: new Date(snapshot.readAtMs),
    ...(markRestoredFromSession ? { restoredFromSession: true as const } : {}),
    revisionId: snapshot.revisionId,
    sizeBytes: snapshot.sizeBytes,
    sourceTool: snapshot.tool,
  });
  return true;
}

function setReadState(
  readFileState: ReadFileStateMap,
  filePath: string,
  content: string,
  metadata: {
    isPartialView?: boolean;
    limit?: number;
    mtimeMs?: number;
    offset?: number;
    readAt: Date;
    requestedPath?: string;
    restoredFromSession?: true;
    revisionId?: string;
    sizeBytes?: number;
    sourceTool?: PersistedReadFileStateTool;
  },
): void {
  setReadFileStateEntry(readFileState, {
    path: filePath,
    ...(metadata.requestedPath === undefined ? {} : { requestedPath: metadata.requestedPath }),
    content,
    offset: metadata.offset,
    limit: metadata.limit,
    isPartialView: metadata.isPartialView ?? false,
    readAt: metadata.readAt,
    sourceTool: metadata.sourceTool,
    revisionId: metadata.revisionId,
    mtimeMs: metadata.mtimeMs,
    sizeBytes: metadata.sizeBytes ?? Buffer.byteLength(content, "utf8"),
    ...(metadata.restoredFromSession ? { restoredFromSession: true } : {}),
  });
}

interface HistoricalReadWindow {
  limit?: number;
  offset?: number;
}

function isHistoricalFullReadWindow({ offset, limit }: HistoricalReadWindow): boolean {
  return (offset ?? 1) <= 1 && limit === undefined;
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

/**
 * Within one assistant, snapshots are ordered by `snapshotIndex` — the order live wrote the
 * read state.
 *
 * Bug cause: parts are persisted in declaration order before the tool starts and updated in
 * place on completion; the order tool results return is not the write order either. With a
 * parallel full Read followed by a write, live ends with the full view while replaying in part
 * order leaves the range view, so after restart the same full Read returns the body instead of
 * file_unchanged. If any snapshot lacks `snapshotIndex` (old data), keep the original part order.
 *
 * Only structured snapshots recorded by the same-named tool on a completed tool part count.
 * Resume does not restore from provider-visible cat-n text; only snapshots carrying
 * mtimeMs / revisionId / sizeBytes can support the later stale guard.
 *
 * Bug cause: old data also stored a snapshot for Reads that returned file_unchanged (a copy of
 * the then-latest record). Replaying it would move the read time to this call's time, and when
 * the earlier real read is not in the active history it would restore a view whose original
 * text the model never saw. Skip such results and let the earlier real read restore.
 */
function inSnapshotOrder(parts: MessagePart[]): RestorableSnapshot[] {
  const snapshots = parts.flatMap((part) => {
    if (!isCompletedToolPart(part)) return [];
    if (part.tool === "Read" && part.state.output === READ_FILE_UNCHANGED_STUB) return [];
    const snapshot = parseReadFileStateMetadata(part.state.metadata);
    return snapshot?.tool === part.tool ? [{ requestedPath: inputFilePath(part), snapshot }] : [];
  });
  if (snapshots.some(({ snapshot }) => snapshot.snapshotIndex === undefined)) return snapshots;
  return snapshots.toSorted(
    (left, right) => (left.snapshot.snapshotIndex ?? 0) - (right.snapshot.snapshotIndex ?? 0),
  );
}

interface RestorableSnapshot {
  snapshot: PersistedReadFileStateMetadata;
  /** The raw form of `file_path` in the tool input; compaction backfill re-checks deny against it. */
  requestedPath?: string;
}

// Bug cause: the raw form used to be persisted with the snapshot; records written before this
// field existed lack it, so after an upgrade a cold restore's compaction backfill judged deny by
// the normalized path only and rules on relative spellings could not block. Tool parts have
// always stored the input, so take it from here — same for old and new records.
function inputFilePath(part: CompletedToolPart): string | undefined {
  const filePath = part.state.input.file_path;
  return typeof filePath === "string" ? filePath : undefined;
}

function isCompletedToolPart(part: MessagePart): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed" && "output" in part.state;
}
