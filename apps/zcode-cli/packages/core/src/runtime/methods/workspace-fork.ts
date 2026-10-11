import {
  CoreErrorType,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  MessageId,
  SessionId,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointsForMessages,
  formatWorkspaceForkAtMessageNoticeBody,
  throwIfTurnAborted,
} from "../helpers/index.js";
import {
  buildForkHistoryMessages,
  copyGoalStateForFork,
  createForkedSession,
  forkConversationFromMessage,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork.js";
import type { WorkspaceRewindRestoredFile, WorkspaceForkResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function restoreWorkspaceCheckpointFiles(
  runtime: AgentRuntimeInternal,
  files: WorkspaceCheckpointArtifact["files"],
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<WorkspaceRewindRestoredFile[]> {
  if (!runtime.fileSystemPort) {
    throw createCoreError(CoreErrorType.ConfigurationError, "FileSystemPort is not configured", {
      recoverable: true,
    });
  }

  const restoredFiles: WorkspaceRewindRestoredFile[] = [];
  for (const file of files) {
    throwIfTurnAborted(abortSignal);
    if (!file.existedBefore || file.beforeContent === null) {
      await runtime.fileSystemPort.removeFile(
        {
          path: file.path,
          missingOk: true,
          trace: traceContext,
        },
        { signal: abortSignal },
      );
      restoredFiles.push({
        action: "delete",
        path: file.path,
      });
      continue;
    }

    const write = await runtime.fileSystemPort.writeTextFile(
      {
        path: file.path,
        content: file.beforeContent,
        createParents: true,
        atomic: true,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    restoredFiles.push({
      action: "restore",
      bytesWritten: write.bytesWritten,
      path: file.path,
    });
  }

  return restoredFiles;
}

export async function forkWorkspaceAtMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Fork target message not found in session store: ${options.targetMessageId}`,
      {
        context: {
          messageId: options.targetMessageId,
        },
        recoverable: true,
      },
    );
  }

  const forkHistoryEndIndex = resolveForkHistoryEndIndex(forkSourceMessages, targetIndex, true);
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  // Only checkpoints after the fork point need to be undone. The target turn's own checkpoint belongs to copied history
  // and its artifacts must be retained. A checkpoint may be attached to both assistant/tool messages; treat any checkpoint
  // in the history prefix as "before the fork point" to avoid rolling back a turn that crosses the boundary.
  const historyMessageIds = forkSourceMessages
    .slice(0, forkHistoryEndIndex)
    .map((message) => message.info.id);
  const historyCheckpointIds = new Set(
    selectCheckpointsForMessages(sessionEvents, historyMessageIds).map(
      (checkpoint) => checkpoint.checkpointId,
    ),
  );
  const laterMessageIds = forkSourceMessages
    .slice(forkHistoryEndIndex)
    .map((message) => message.info.id);
  const laterCheckpoints = selectCheckpointsForMessages(sessionEvents, laterMessageIds).filter(
    (checkpoint) => !historyCheckpointIds.has(checkpoint.checkpointId),
  );

  if (laterCheckpoints.length === 0) {
    // There are no file changes after the fork point, so the workspace is already at the fork-point state; this is equivalent to a conversation-only fork and touches no files.
    return await forkConversationFromMessage.call(this, {
      forkedSessionId: options.forkedSessionId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  if (!this.artifactStore || !this.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Fork requires session, artifact, and file-system adapters.",
      {
        context: {
          hasArtifactStore: Boolean(this.artifactStore),
          hasFileSystemPort: Boolean(this.fileSystemPort),
          hasSessionStore: true,
        },
        recoverable: true,
      },
    );
  }

  // Read all snapshots before producing side effects: any missing artifact fails the whole fork,
  // preventing files from being partially written and leaving the workspace in neither the fork-point nor current state.
  const artifacts: WorkspaceCheckpointArtifact[] = [];
  for (const checkpoint of laterCheckpoints) {
    throwIfTurnAborted(options.abortSignal);
    const read = await this.artifactStore.readToolResultArtifact(
      {
        uri: checkpoint.snapshotRef,
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    artifacts.push(parseWorkspaceCheckpointArtifact(JSON.parse(read.content)));
  }

  // A file's state at the fork point is the before-state from its first change after the fork point.
  // If the same file changed multiple times, apply only the earliest one; it subsumes the later changes.
  const earliestFileByPath = new Map<string, WorkspaceCheckpointArtifact["files"][number]>();
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      if (!earliestFileByPath.has(file.path)) {
        earliestFileByPath.set(file.path, file);
      }
    }
  }

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });
  const forkHistoryMessages = buildForkHistoryMessages(
    parentMessages,
    forkSourceMessages,
    targetIndex,
    forkHistoryEndIndex,
  );
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  const restoredFiles = await restoreWorkspaceCheckpointFiles(
    this,
    Array.from(earliestFileByPath.values()),
    options.traceContext,
    options.abortSignal,
  );
  // Normalize all three paths: forkWorkspaceAtMessage must not write only a synthetic notice without
  // a session_fork timeline part (unlike the other two fork paths, which would make the fork boundary differ after cold recovery).
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatWorkspaceForkAtMessageNoticeBody({
      parentSessionId: this.sessionId,
      restoredFiles,
      targetMessageId: options.targetMessageId,
      undoneCheckpointCount: laterCheckpoints.length,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: restoredFiles.length,
      },
    },
    traceContext: options.traceContext,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: forkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles,
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages and restored ${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"} to the fork point.`,
  };
}
