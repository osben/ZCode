import { stat } from "node:fs/promises";
import { restorePermissionGrantMarker } from "../helpers/permission-grant-resume.js";
import { executionStateSchema, resolveExecutionState } from "@zcode/shared";
import { SESSION_ENTRY_EXECUTION_STATE } from "@zcode/contracts";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  traceContextToLogContext,
  formatGoalStateForModel,
  activeSessionMessages,
  hydrateReadFileStateFromSession,
  hydrateMessageHistoryFromSession,
  MessageHistoryImpl,
} from "../deps.js";
import type {
  EnvInfo,
  MessageWithParts,
  SessionEvent,
  SessionGoal,
  SessionInfo,
  SessionTitleSource,
  TodoItem,
  TraceContext,
  TurnId,
  TurnState,
  ToolSchedule,
} from "../deps.js";
import { getLatestActiveSessionMessageId, isHiddenReminderMessage } from "../helpers/index.js";
import type { ResumeSessionOptions, ResumeSessionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { restoreDynamicWorkflowActivationOnResume } from "./dynamic-workflow-activation.js";
import { restoreSessionFeaturesOnResume } from "../session-features/contract.js";
import { repairPersistedRemoteSessionPaths } from "../helpers/persisted-remote-session-path-repair.js";
import {
  restoreWorkspaceCheckpointEntries,
  restoreWorkspaceFileRewindEntries,
} from "./workspace-checkpoint-persistence.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";
import { refreshRestoredAnnouncements } from "./context-refresh.js";
import { loadPromptSnapshot } from "../helpers/prompt-snapshot.js";
import { stageSessionStartContext } from "./hooks.js";
import { collectPreviousRuntimeAgentInterruptions } from "./background-notifications.js";
import { createTotalTokensBudgetState } from "../helpers/total-tokens-budget.js";

/**
 * fork 子会话在 fork 提示之后还没有输入时，SessionStart 用 fork，之后用 resume。
 * 由历史推出，不另存状态。
 */
function sessionStartSourceForResume(
  activeMessages: readonly MessageWithParts[],
): "resume" | "fork" {
  const forkNoticeIndex = activeMessages.findLastIndex(
    (message) => message.info.role === "user" && message.info.source === "fork",
  );
  if (forkNoticeIndex < 0) return "resume";
  const hasInputAfterFork = activeMessages
    .slice(forkNoticeIndex + 1)
    .some(
      (message) =>
        message.info.role === "user" && !message.info.summary && !isHiddenReminderMessage(message),
    );
  return hasInputAfterFork ? "resume" : "fork";
}

export function toScheduleState(
  this: AgentRuntimeInternal,
  schedule: ToolSchedule,
): TurnState["scheduledTools"] {
  return {
    items: schedule.items.map((item) => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}

export async function resumeFromStore(
  this: AgentRuntimeInternal,
  options?: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  if (!this.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot resume session without a session store",
      { recoverable: false },
    );
  }

  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const persistedSession = await this.sessionStore.getSession(this.sessionId);
  // Deleted = CLI soft delete (time_deleted). Archiving moved to Host organization state and the CLI has no archive column;
  // the old time.archived check was always false, so this now refuses to resume soft-deleted sessions instead.
  if (!persistedSession || persistedSession.time.deleted !== undefined) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: { sessionId: this.sessionId },
      recoverable: true,
    });
  }
  const session = await repairPersistedRemoteSessionPaths(this.sessionStore, persistedSession, {
    onPersistenceFailure: (error) => {
      this.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.path_repair.persist_failed",
        module: "core.runtime",
        sessionId: this.sessionId,
      });
    },
  });

  const messages =
    options?.persistedMessages ??
    (await this.sessionStore.messages({
      sessionID: this.sessionId,
    }));
  const rewindTargetMessageId = session.revert?.targetMessageID;
  const rewindCreatedMessageId = session.revert?.createdMessageID;
  const rewindKeptMessageIds = session.revert?.keptMessageIDs;
  const branchCutAfterMessageId = session.revert?.branchCutAfterMessageID;
  this.branchGeneration = session.revert?.branchGeneration ?? 0;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
  if (messages.length === 0) {
    this.logger?.warn("Session resume loaded zero persisted messages", {
      ...traceContextToLogContext(traceContext),
      directory: session.directory,
      event: "session.resume.persisted_messages_zero",
      module: "core.runtime",
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }
  const persistedEnvInfo = extractPersistedEnvInfo(messages);
  if (persistedEnvInfo) {
    this.config.envInfo = persistedEnvInfo;
  }
  // shell 不从会话恢复：resume 入口已按当前设置初始化 selection，变化由环境公告告诉模型。

  // Execution-worktree sessions persist their execution cwd separately from the workspace
  // directory (listing identity); restore the worktree first so the resumed turn runs there.
  // If it was deleted out-of-band, keep the missing path as cwd and block workspace tools below;
  // the fact stays on runtime config for the sessions-index badge and environment context.
  this.workingDirectory = session.executionDirectory ?? session.directory;
  if (session.executionDirectory) {
    let executionWorktreeMissing: boolean;
    try {
      executionWorktreeMissing = !(await stat(session.executionDirectory)).isDirectory();
    } catch {
      executionWorktreeMissing = true;
    }
    if (executionWorktreeMissing) {
      this.logger?.warn(
        "Session resume execution worktree directory is missing; workspace tools remain blocked until it is restored",
        {
          ...traceContextToLogContext(traceContext),
          event: "session.resume.execution_worktree_missing",
          module: "core.runtime",
          path: session.executionDirectory,
          sessionId: this.sessionId,
        },
      );
    }
    this.config.executionWorktree = {
      path: session.executionDirectory,
      ...(session.executionBranch ? { branchName: session.executionBranch } : {}),
      ...(executionWorktreeMissing ? { missing: true } : {}),
      workspacePath: session.directory,
    };
  }
  this.config.taskType = session.taskType;
  if (this.config.memory) {
    // The Memory root must use the workspace identity persisted with the session, not the workspace from process startup.
    this.config.memory.workspaceIdentity = session.workspaceID
      ? String(session.workspaceID)
      : undefined;
  }
  resetProjectMemoryRecall(this);
  this.messageHistory = new MessageHistoryImpl();
  this.contextBuilder = null;
  this.contextInitialized = false;
  // 修复原因：bootstrap 复用同一个 runtime 再次恢复时，原因还停在上一次 compaction；
  // 恢复后启动时重读的文件变化被写成"compaction 之后重读"。恢复等同新会话启动，回到 session_start。
  this.instructionRefreshReason = undefined;
  // token 预算计数器只在内存：恢复等同新会话启动，从零开始，下一条真实用户消息重新起算。
  this.totalTokensBudget = createTotalTokensBudgetState();
  // cold resume 的历史 hydration 会先清空 runtime-local read-state；必须在
  // Context 初始化前完成，确保随后单次加载的 MEMORY.md 状态与 provider 所见内容一致。
  const readFileStateHydration = await hydrateReadFileStateFromSession({
    branchCutAfterMessageId,
    markRestoredFromSession: true,
    messages,
    readFileState: this.readFileState,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
  });
  await this.ensureContextInitialized(traceContext);
  // 第一个轮次重建前缀前装好 prompt 快照，恢复后的请求发送会话记录的 system。
  await loadPromptSnapshot(this, traceContext);
  // 恢复的 envInfo 来自存储，不是刚读的 Git，不能当预取；恢复的窗口还没决定过时，下一次请求重新读取。
  this.sessionStartGitPrefetch = false;
  // The stored "is repository" flag was not read by this runtime; re-read once for the first environment announcement and announce on change.
  this.repositoryRecheckPending = true;
  const recoveredCompactTimelineCount = await this.recoverInterruptedCompactTimelines(
    messages,
    traceContext,
  );
  const hydration = await hydrateMessageHistoryFromSession({
    logger: this.logger,
    artifactStore: this.artifactStore,
    branchCutAfterMessageId,
    history: this.messageHistory,
    messages,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  refreshRestoredAnnouncements(this);
  const activeMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  // The compact-preserved segment inserts pre-compact messages back into provider context,
  // but it is not the latest anchor in the post-compact timeline and cannot be used as a later compact parentID.
  const timelineActiveMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;

  await restoreWorkspaceCheckpointEntries(this, traceContext);
  await restoreWorkspaceFileRewindEntries(this, traceContext);
  const restoredEvents = await this.eventStore.getEvents(this.sessionId);
  const restoredModeEvents = restoredEvents.filter(
    (event) =>
      event.type === SessionEventType.SessionCreated ||
      event.type === SessionEventType.SessionModeChanged,
  );
  const restoredMode =
    restoredModeEvents.length > 0 ? this.eventReducer.reduce(restoredModeEvents).mode : undefined;
  const resolvedMode = options?.modeOverride ?? restoredMode ?? session.permission?.mode;
  if (resolvedMode !== undefined) {
    // Cold resume first restores local events such as checkpoint/rewind into the new in-memory eventStore.
    // These events carry no mode; reducing merely because any event exists would overwrite headless yolo with the default build mode.
    // Only authoritative mode events restore the historical value; an explicit/default mode for this invocation still has highest priority.
    Object.assign(this.config, resolveExecutionState({ mode: resolvedMode }));
  }
  // New session-specific records take precedence over project preferences; read legacy records only for compatibility and do not backfill them in bulk.
  const executionEntries = await this.sessionStore.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
  });
  const savedExecution = executionStateSchema.safeParse(executionEntries?.at(-1)?.data);
  if (savedExecution.success && options?.modeOverride === undefined) {
    Object.assign(this.config, savedExecution.data);
  }
  // Fix reason: subagent resume used to reuse the persisted execution state, so after the parent changed from yolo to build, a resumed child still ran commands without approval.
  // The full execution state supplied by the caller applies last, overriding the historical mode and persisted state above.
  if (options?.executionStateOverride) Object.assign(this.config, options.executionStateOverride);
  // Restore the tool surface for onDemand sessions from persisted state (launch.md, “On demand: activation”): activate if an entry exists or history
  // contains `/workflow` / one of the ten tool calls. This must finish before the first turn, so do it during resume rather than waiting for the next turn.
  await restoreDynamicWorkflowActivationOnResume.call(this, messages);
  // Session feature tags grow but never shrink: entry ∪ persisted history, and this must finish before the first model request
  // (docs/design/v2/model/session-features-header.md, "Inheritance and resume").
  await restoreSessionFeaturesOnResume.call(this, messages, traceContext);

  await restorePermissionGrantMarker(this, traceContext);

  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: messages,
  });
  // Hidden reminders are not conversation messages and do not count as a turn (same criterion as rewind-message.ts).
  this.turnNumber = activeMessages.filter(
    (message) =>
      message.info.role === "user" && !message.info.summary && !isHiddenReminderMessage(message),
  ).length;
  this.sessionPersisted = true;
  await syncPersistedSessionTitleForResume.call(this, {
    restoredEvents,
    session,
    traceContext,
  });
  await this.discardPersistedPendingSteerInputs(traceContext);
  this.pendingPreviousRuntimeAgentNotice = await collectPreviousRuntimeAgentInterruptions
    .call(this, activeMessages)
    .catch((error: unknown) => {
      // 对账只补一条提醒；读取 child 失败不能让会话恢复失败。
      this.logger?.warn("Previous runtime agent reconciliation failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.resume.previous_runtime_agents_failed",
        module: "core.runtime",
      });
      return undefined;
    });
  const recoveredSteerInputCount = 0;
  const resumedTodos = await this.readSessionTodosForContext(traceContext);
  const resumedTarget = await this.readSessionTargetForContext(traceContext);
  this.injectTargetStateIntoMessageHistory(resumedTarget);

  const resumedEvent = this.createEvent(
    SessionEventType.SessionResumed,
    {
      directory: session.directory,
      interruptedToolCount: hydration.interruptedToolCount,
      messageCount: hydration.messageCount,
      partCount: hydration.partCount,
      recoveredCompactTimelineCount,
      recoveredSteerInputCount,
      resumedTodoCount: resumedTodos.length,
      resumedTarget: resumedTarget?.status,
    },
    traceContext,
  );
  await this.appendEvent(resumedEvent, traceContext);
  const sessionStartHookResult = await this.runSessionStartHooks(
    sessionStartSourceForResume(activeMessages),
    traceContext,
    options?.abortSignal,
  );
  // 只打开会话不写库，否则每次打开都多一行；结果等下一轮会话写库后再提交。
  stageSessionStartContext(this, sessionStartHookResult.additionalContexts);

  if (messages.length > 0 && activeMessages.length === 0) {
    this.logger?.warn("Session resume produced zero active messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      appliedMessageCount: hydration.appliedMessageCount,
      directory: session.directory,
      event: "session.resume.active_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      sessionId: this.sessionId,
      rewindTargetMessageId,
    });
  }
  if (activeMessages.length > 0 && hydration.appliedMessageCount === 0) {
    this.logger?.warn("Session resume applied zero history messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      directory: session.directory,
      event: "session.resume.applied_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }

  this.logger?.info("Session resumed", {
    ...traceContextToLogContext(traceContext),
    appliedMessageCount: hydration.appliedMessageCount,
    directory: session.directory,
    event: "session.resumed",
    interruptedToolCount: hydration.interruptedToolCount,
    messageCount: hydration.messageCount,
    module: "core.runtime",
    partCount: hydration.partCount,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    recoveredCompactTimelineCount,
    resumedTodoCount: resumedTodos.length,
    resumedTargetStatus: resumedTarget?.status,
    sessionId: this.sessionId,
    status: "completed",
  });

  return {
    ...hydration,
    directory: session.directory,
    // Interrupted compact recovery writes back a timeline part; bootstrap must not pass pre-recovery
    // messages to V4, or the first frame will briefly revive the started/retrying state.
    persistedMessagesReloadRequired: recoveredCompactTimelineCount > 0,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    traceId: traceContext.traceId,
  };
}

async function syncPersistedSessionTitleForResume(
  this: AgentRuntimeInternal,
  input: {
    restoredEvents: SessionEvent[];
    session: SessionInfo;
    traceContext: TraceContext;
  },
): Promise<void> {
  const title = input.session.title.trim();
  if (!title) return;
  const source = input.session.titleSource ?? "generated";
  if (hasRestoredTitleEvent(input.restoredEvents, title, source)) return;

  // The title is already written to sessionStore when a fork child is created, but copying history does not copy the parent's
  // SessionTitleUpdated event. The v4 live projection consumes only the event stream, so without this event the list title falls back to "New task."
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle: "",
        source,
        title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

function hasRestoredTitleEvent(
  events: readonly SessionEvent[],
  title: string,
  source: SessionTitleSource,
): boolean {
  return events.some((event) => {
    if (event.type !== SessionEventType.SessionTitleUpdated) return false;
    const payload = event.payload as { source?: unknown; title?: unknown };
    return payload.title === title && payload.source === source;
  });
}

function extractPersistedEnvInfo(messages: MessageWithParts[]): EnvInfo | undefined {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }

    const envInfo = message.info.contextSnapshot?.envInfo;
    if (envInfo) {
      return envInfo;
    }
  }

  return undefined;
}

export async function readSessionTodosForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<TodoItem[]> {
  if (!this.sessionStore) {
    return [];
  }

  try {
    return await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    // Todo state is continuity context. If the store cannot read it, resume/compact can still
    // proceed from transcript history while surfacing the degradation in structured logs.
    this.logger?.warn("Failed to read session todos for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "todo.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return [];
  }
}

export async function readSessionTargetForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) {
    return null;
  }

  try {
    return await this.sessionStore.readTarget({ sessionID: this.sessionId });
  } catch (error) {
    // Goal state is continuity context. Resume should still work from transcript history
    // if goal storage is temporarily unavailable.
    this.logger?.warn("Failed to read session goal for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

export function injectTargetStateIntoMessageHistory(
  this: AgentRuntimeInternal,
  target: SessionGoal | null,
): void {
  const targetState = formatGoalStateForModel(target);
  if (!targetState) {
    return;
  }

  this.messageHistory.addAttachment(
    "resume_goal_state",
    [
      "The current session goal state was restored from session storage.",
      targetState,
      "Use it as the authoritative long-running objective unless a later GoalRead result or runtime goal event updates it.",
      "Do not mark the goal complete unless real evidence shows the objective has been achieved.",
      "A completed plan, todo list, checklist, or planning phase is not completion evidence unless the objective was only to produce that artifact.",
    ].join("\n"),
  );
}
