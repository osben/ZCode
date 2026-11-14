import {
  appendRequestAnnouncements,
  appendRuntimeContextAnnouncements,
  appendRuntimeSkillsAnnouncement,
  persistAnnouncements,
} from "./context-refresh.js";
import { getTurnTools } from "./turn-tool-visibility.js";
import { refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBodyForTask,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildSilentTurnReminderBody,
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { settleLspPreferences } from "./lsp.js";
import { latestContextTokens, querySourceForTask } from "./turn-model-step-usage.js";
import { inputRoleOf, isRealUserPrompt } from "../helpers/provider-entry-origins.js";
import {
  consumeTotalTokensBudget,
  decideTotalTokensReminder,
  reanchorTotalTokensBudget,
  type InputAttachmentCollectionReason,
} from "../helpers/total-tokens-budget.js";
import { formatTotalTokensReminder } from "../../context/total-tokens.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";
import { recordSessionFeatureFromToolSearchExposure } from "../session-features/contract.js";
import { recordPromptSnapshot } from "../helpers/prompt-snapshot.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    refreshOffPeakTurnAfterTakeover(this, state);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
      // Only a complete tool-result batch may set this one-time guide diagnostic; ordinary queue items are not consumed
      // at the start of a model roundtrip, preventing a future turn from being incorrectly merged into the current product turn.
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    // Drain notifications only before a request that carries new input: after a complete tool batch, or after a guide
    // follows a text reply, the same moment as input attachments.
    // Fix reason: draining on every iteration also injected notifications into requests that resend the same input
    // (Stop hook continuation, stream retry, fallback); otherwise they stay queued and start a new turn after this one.
    if (
      state.inputAttachmentCollectionPending &&
      state.modelStepCount > 0 &&
      !outputTokenRecoveryActive
    ) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
        state.toolLoopHistory = undefined;
      }
    }

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // Apply tools/list_changed only before a turn starts.
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    // The initial LSP availability check runs unawaited at construction. Settle it so the LSP tool
    // cannot join the tool list (the head of the cached prompt prefix) after the first request.
    await settleLspPreferences.call(this);
    const tools = getTurnTools(this, state);
    finishTools();

    // 输入附件在 compaction 之前运行：本轮输入或上一批工具结果产生的项属于 compaction
    // 保留或摘要的历史。只在有新输入时收集（轮首、完整工具批次之后、文本回复后续上 guide）；
    // 新轮通知的首个请求跳过。
    // Stop hook 续跑、模型降级、流恢复、Start Plan 排队重试、上下文超限恢复、闲时换票
    // 都重发同一份输入，不收集：每次收集都会多出一条 output_style 等不去重的附件。
    const collectionReason = state.inputAttachmentCollectionPending;
    if (collectionReason) {
      state.inputAttachmentCollectionPending = false;
      // 收集只追加附件，最新的非附件 entry 在收集期间不变；只查一次，跳过规则和预算提醒共用。
      const latestMessage = state.turnRequestState.entries.findLast(
        (entry) => !isRuntimeAttachmentEntry(entry),
      );
      if (!isNewTurnInput(latestMessage)) {
        // 触发收集的输入是否出自用户本人：纯文本回复后看本次取出的 guide（历史 metadata 不可靠，
        // 见 isUserSteer），其余看最新输入。
        const fromUser =
          collectionReason === "text_guide"
            ? drainedSteerForNextRequest?.userSteered === true
            : latestMessage !== undefined && isRealUserPrompt(latestMessage);
        await collectInputAttachments(this, state, tools, collectionReason, fromUser);
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      // Memory prefetch comes after input attachments.
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        getAgentListingTools: () => tools,
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    // Pre-request announcements run after compaction and ignore the input-attachment skip rules;
    // they deduplicate against history by type and are usually empty.
    await appendRequestAnnouncements(
      this,
      state.turnRequestState,
      state.turnTraceContext,
      state.turnAbortSignal,
    );
    const requestEntries = [...state.turnRequestState.entries];
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    // 主会话没有可用的 prompt 快照时，按本次请求的前缀记录 system。
    await recordPromptSnapshot(this, {
      model: state.model,
      modelSelectionScope: state.modelSelectionScope,
      entries: requestEntries,
      traceContext: state.turnTraceContext,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // The capability tag takes the effective mode of this main-loop request and is recorded before the model call, so
    // this request already carries it. Request preparation itself writes no state, so the caller records it; request
    // preparation for compact, target verification and Memory does not pass through here.
    recordSessionFeatureFromToolSearchExposure.call(
      this,
      prepared.toolSearch,
      state.turnTraceContext,
    );
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

      // Production needs to know whether a Turn crossed the provider boundary. Record request metadata only;
      // do not log prompts, message content, or streaming chunks, to avoid content exposure and control log volume.
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      originEntries: providerProjection.originEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}

/**
 * Turns opened by a new-turn notification or a peer message skip input attachments on their first request.
 * Pre-request announcements are unaffected: they still run and bubble before the notification during projection.
 * The check reads history only, so it stays consistent after resume/fork/rewind; once a tool is called the latest
 * entry becomes a tool result and later requests collect as usual.
 */
function isNewTurnInput(latestMessage: RuntimeMessageEntry | undefined): boolean {
  return latestMessage !== undefined && inputRoleOf(latestMessage) === "new_turn";
}

/**
 * Input attachment collection runs in a fixed order; each item keeps its own trigger condition.
 * Everything is written to history so the prefix is unchanged after resume. The todo reminder is committed before it
 * is persisted; every other item is committed only after it is persisted.
 */
async function collectInputAttachments(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
  reason: InputAttachmentCollectionReason,
  fromUser: boolean,
): Promise<void> {
  await appendRuntimeContextAnnouncements(
    runtime,
    state.turnRequestState,
    state.model,
    state.turnOutputStyle,
    state.turnTraceContext,
    state.turnAbortSignal,
  );
  // The ToolSearch announcement (deferred tools delta) comes after the model and before the agent listing.
  await appendToolSearchAnnouncement(runtime, state, tools);
  await appendRuntimeAgentListing(runtime, state.turnRequestState, tools, state.turnTraceContext);
  await appendRuntimeSkillsAnnouncement(runtime, state.turnRequestState, state.turnTraceContext);
  // Only runtimes with a language-server service pay for this step; others keep the exact previous microtask sequence.
  if (runtime.lspService) {
    // Post-edit LSP diagnostics: returns at once unless a file was mutated since the previous request (spec §6).
    const lspDiagnosticsBody = await runtime.collectLspEditDiagnosticsBody(state.turnAbortSignal);
    throwIfTurnAborted(state.turnAbortSignal);
    if (lspDiagnosticsBody) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry("diagnostics", lspDiagnosticsBody),
      ]);
    }
  }
  // A background agent interrupted when the previous runtime exited: recovery only records it, and it is
  // delivered with the next persisted turn (no separate turn is opened for it).
  const previousRuntimeAgentNotice = runtime.pendingPreviousRuntimeAgentNotice;
  if (previousRuntimeAgentNotice) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("task_status", previousRuntimeAgentNotice)],
      state.turnTraceContext,
    );
    runtime.pendingPreviousRuntimeAgentNotice = undefined;
  }
  // The exit reminder is derived from history (no exit reminder after the latest plan reminder); the in-memory flag is
  // only an extra trigger. Fix reason: with only the flag, a cold resume lost it and the plan-mode exit reminder never fired.
  if (
    !runtime.getPlanEnabled() &&
    (runtime.needsPlanModeExitReminder || isPlanModeExitPending(state.turnRequestState.entries))
  ) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody())],
      state.turnTraceContext,
    );
    runtime.needsPlanModeExitReminder = false;
  }
  const runtimeModeReminderBody = buildRuntimeModeReminderBodyForTask(
    state.turnRequestState.entries,
    {
      mode: runtime.getMode(),
      planEnabled: runtime.getPlanEnabled(),
      taskType: runtime.config.taskType,
      tools,
    },
  );
  if (runtimeModeReminderBody) {
    // Writing only to memory loses the reminder and its counting boundary on cold resume; reuse the persistence and
    // hydration of dynamic announcements.
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody)],
      state.turnTraceContext,
    );
  }
  if (
    tools.some((tool) => tool.name === "TodoWrite") &&
    shouldBuildTodoReminder(state.turnRequestState.entries)
  ) {
    const currentTodos = await runtime.readSessionTodosForContext(state.turnTraceContext);
    const reminderBody = buildTodoReminderBody(currentTodos);
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("todo_reminder", reminderBody),
    ]);
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
      sessionId: runtime.sessionId,
      source: "todo_reminder",
      text: reminderBody,
      traceContext: state.turnTraceContext,
    });
  }
  const silentReminderBody =
    state.modelStepCount > 0 && querySourceForTask(runtime.config.taskType) === "main_turn"
      ? buildSilentTurnReminderBody(state.turnRequestState.entries)
      : null;
  if (silentReminderBody) {
    // History is the only source of the count; persist before committing so a failure leaves no false "already reminded" mark.
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("silent_turn_reminder", silentReminderBody)],
      state.turnTraceContext,
    );
  }
  await appendTotalTokensReminder(runtime, state, reason, fromUser);
  // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
  // 一律走 ui/update-model-context。
  // output_style 每次收集都产出，不去重。修复原因：只在首步发且不落 session 时，
  // 工具批次后的请求缺少它，resume 后的前缀也会变化。
  const outputStyleReminderBody = buildRuntimeOutputStyleReminderBody(state.turnOutputStyle);
  // Dream may finish during the first model request of the same turn; check on every collection so the one-time update
  // goes into the next request. Fix reason: as an entry owned by a single request, later requests lacked it and the
  // request prefix within the same session changed.
  const pendingMemoryUpdate = runtime.pendingMemoryUpdate;
  const memoryUpdate = consumePendingProjectMemoryUpdate(runtime);
  try {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [
        ...(outputStyleReminderBody
          ? [systemReminderAttachmentEntry("output_style", outputStyleReminderBody)]
          : []),
        ...(memoryUpdate ? [memoryUpdate] : []),
      ],
      state.turnTraceContext,
    );
  } catch (error) {
    // Fix reason: the update is taken before the database write, so a failed write lost this one-time update forever.
    // Put it back for the next collection to resend; if Dream produced a newer version meanwhile, keep the newer one.
    runtime.pendingMemoryUpdate ??= pendingMemoryUpdate;
    throw error;
  }
  // UserPromptSubmit 的上下文是本轮输入附件批次的最后一项，在请求前公告之前；只在本轮第一次收集时写入。
  // 新轮通知跳过首次收集，但这类轮次不运行 UserPromptSubmit，所以不会被推迟。
  if (state.userPromptHookContext) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [state.userPromptHookContext],
      state.turnTraceContext,
    );
    state.userPromptHookContext = undefined;
  }
}

/**
 * token 预算倒数：数值来自 runtime 计数器与最近一条带 usage 的 assistant。
 * 先写库再提交并更新计数器；写库失败时计数器保持原值，错误向上冒泡。
 */
async function appendTotalTokensReminder(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  reason: InputAttachmentCollectionReason,
  fromUser: boolean,
): Promise<void> {
  const entries = state.turnRequestState.entries;
  const decision = decideTotalTokensReminder({
    reason,
    mainSession: querySourceForTask(runtime.config.taskType) === "main_turn",
    fromUser,
  });
  if (!decision.emit) return;
  const context = latestContextTokens(entries);
  const budget = decision.reanchor
    ? reanchorTotalTokensBudget(runtime.totalTokensBudget, context)
    : runtime.totalTokensBudget;
  const consumed = consumeTotalTokensBudget(budget, context);
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    [
      systemReminderAttachmentEntry(
        "total_tokens_reminder",
        formatTotalTokensReminder(consumed.remaining),
      ),
    ],
    state.turnTraceContext,
  );
  runtime.totalTokensBudget = consumed.state;
}

async function appendToolSearchAnnouncement(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
): Promise<void> {
  const announcement = buildToolSearchAnnouncement({
    model: state.model,
    mode: runtime.config.toolSearch?.mode,
    tools,
    registry: runtime.getToolRegistry(),
    entries: state.turnRequestState.entries,
  });
  // The announcement body and its delta facts must be persisted together first; otherwise fork/resume treats already
  // announced tools as appearing for the first time.
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    announcement ? [announcement] : [],
    state.turnTraceContext,
    state.model,
  );
}

function isPlanModeExitPending(entries: readonly RuntimeMessageEntry[]): boolean {
  const latest = entries.findLast(
    (entry) =>
      isRuntimeAttachmentEntry(entry) &&
      (entry.metadata.source === "runtime_mode" || entry.metadata.source === "plan_mode_exit"),
  );
  return latest?.metadata?.source === "runtime_mode";
}
