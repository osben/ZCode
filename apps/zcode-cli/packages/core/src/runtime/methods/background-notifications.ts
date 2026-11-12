import {
  createMessageId,
  createSessionId,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, MessageWithParts, SessionId, TraceContext } from "../deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import { createRuntimeCommandId, type TaskNotificationRuntimeCommand } from "../command-queue.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SealBackgroundTaskNotificationsInput } from "../types.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import { joinTaskNotificationBatch } from "../../runtime-task/notification.js";
import { formatLocalAgentTaskNotification } from "../../subagent/completion-notification.js";
import { readSubagentRunMetadata } from "../../subagent/runner.js";
import { isBackgroundSubagentStallReminderCurrent } from "../../subagent/background-stall.js";

export function enqueueBackgroundTaskNotification(
  this: AgentRuntimeInternal,
  notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  },
): void {
  if (this.shuttingDown) {
      // Defend the direct-call path: during session teardown, allow task-state settlement only; do not start another model turn.
    this.logger?.info?.("Dropped background task notification during runtime shutdown", {
      ...traceContextToLogContext(notification.traceContext),
      event: "runtime.background_task_notification.shutdown_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
      toolName: notification.toolName,
    });
    return;
  }
  const task = notification.taskId ? this.runtimeTaskRegistry.get(notification.taskId) : undefined;
  const branchGeneration = task?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch background task notification", {
      ...traceContextToLogContext(notification.traceContext),
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "runtime.background_task_notification.stale_branch_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
    });
    return;
  }
  const commandId = createRuntimeCommandId();
  this.enqueueRuntimeCommand({
    branchGeneration,
    createdAt: new Date(),
    id: commandId,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    originMeta: notification.originMeta,
    taskId: notification.taskId,
    text: notification.text,
    toolName: notification.toolName,
    traceContext: notification.traceContext,
  });
  // Record the wake in the ledger as admitted. The runtime command queue is in-memory, so the ledger is the only
  // durable trace. After a crash/restart, the background subprocess is dead and notifications cannot be recovered; resume settles any remaining
  // admitted entries as discarded(session_resumed), preserving an explicit record rather than silently dropping them.
  const admission = this.sessionStore?.saveSessionInput?.({
    id: String(commandId),
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: notification.text,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
      ...(notification.originMeta ? { originMeta: notification.originMeta } : {}),
    },
  });
  if (admission) {
    rememberBackgroundNotificationAdmission(this, String(commandId), admission);
    void this.trackResidencyBlockingWork(admission).catch((error) => {
      this.logger?.warn("Failed to admit background notification to ledger", {
        ...traceContextToLogContext(notification.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  }
}

export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: SealBackgroundTaskNotificationsInput,
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}

export async function persistBackgroundTaskNotificationCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): Promise<MessageId> {
  const persisted = await persistBackgroundTaskNotificationBatch.call(this, [command], true);
  return persisted.messageId;
}

export interface PersistedBackgroundTaskNotificationBatch {
  /** Present only when the entire batch has the same source; do not infer mixed/missing sources from the representative task. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  messageId: MessageId;
  originMeta?: BackgroundResultOriginMeta;
  text: string;
}

const MAX_BACKGROUND_RESULT_TITLES = 3;

function resolveBackgroundTaskNotificationSource(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta["backgroundSource"] | undefined {
  // 无进展提醒不是后台结果：不让它把这一轮记成「由 subagent completion 唤起」
  // （message_source=background_subagent）。整批只有提醒时不带来源（!3563 评审 SG-01）。
  const results = commands.filter((command) => command.originMeta?.subagentStall === undefined);
  const source = results[0]?.originMeta?.backgroundSource;
  if (!source || results.some((command) => command.originMeta?.backgroundSource !== source)) {
    // 展示 metadata 只保留代表任务，不能把首项来源当作整批因果来源；
    // 混合或缺失来源留空，避免 notification 到达顺序改变 message_source。
    return undefined;
  }
  return source;
}

export function resolveBackgroundTaskNotificationOriginMeta(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta | undefined {
  // Single item: pass through originMeta as a whole; workflowNotification payload travels with it (the sole data source for manifest rendering).
  if (commands.length === 1) return commands[0].originMeta;

  const originMetas: BackgroundResultOriginMeta[] = [];
  for (const command of commands) {
    const originMeta = command.originMeta;
    if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
    originMetas.push(originMeta);
  }

  const representative = originMetas[0];
  if (!representative) return undefined;
  const visibleTitles = originMetas
    .slice(0, MAX_BACKGROUND_RESULT_TITLES)
    .map((originMeta) => originMeta.title.trim());
  const remainingCount = originMetas.length - visibleTitles.length;
  const title = [...visibleTitles, ...(remainingCount > 0 ? [`+${remainingCount}`] : [])].join(
    " · ",
  );

  // If originMeta is discarded after multiple notifications share one turn, background results fall back to
  // ordinary assistant rendering. Reuse the first task's display anchor and synthesize only the title; do not add a batch schema.
  //
  // Deliberately do **not synthesize** a workflowNotification payload: the manifest maps one turn to one card, which is not true for a batch.
  // Falsely reporting the first item's payload would be worse than rendering the whole turn as a plain title row. Keep only the three base fields
  // {backgroundSource, title, workId}; the whole turn then falls back to the current title-row rendering.
  return {
    backgroundSource: representative.backgroundSource,
    title,
    workId: representative.workId,
  };
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";

/**
 * 标准 `<task-notification>` 排在前面，无进展提醒、workflow 运行中通知等其它正文排在后面（各自保持
 * 原有顺序）。修复原因：App 与 V4 产品投影只在整段输入以 `<task-notification>` 开头时才逐条解析
 * 终态；合批的第一条若是提醒，同批其它 Agent 的终态就不会更新到它们的工具行。
 * 展示用的 originMeta（标题顺序、代表任务的 workId）按同一顺序取，标题不会以「no progress」开头、
 * 而正文却先是终态。
 */
function orderTaskNotificationsForParsing(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]] {
  const isNotification = (command: TaskNotificationRuntimeCommand) =>
    command.text.trimStart().startsWith(TASK_NOTIFICATION_OPEN);
  return [
    ...commands.filter(isNotification),
    ...commands.filter((command) => !isNotification(command)),
  ] as [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]];
}

export async function persistBackgroundTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
  midTurn = false,
): Promise<PersistedBackgroundTaskNotificationBatch> {
  const firstCommand = commands[0];
  const backgroundSource = resolveBackgroundTaskNotificationSource(commands);
  const ordered = orderTaskNotificationsForParsing(commands);
  const originMeta = resolveBackgroundTaskNotificationOriginMeta(ordered);
  const texts = ordered.map((command) => command.text);
  // 这一轮的输入文本仍以 "\n\n" 相连，App 据此逐条解析任务卡片。
  const text = joinTaskNotificationBatch(texts);
  // Fix reason: the batch used to be stored as one joined string and projection guessed per-item boundaries
  // by the <task-notification> prefix; mid-workflow notifications do not start with it and were folded into
  // the previous notification's wrapper. Idle batches now store each notification as its own text block of
  // the same message, so both what the model sees and what cold resume reads back are wrapped per block
  // without guessing boundaries. Mid-turn notifications are enqueued individually, not batched.
  const blocks = !midTurn && texts.length > 1 ? texts : undefined;
  await this.ensureContextInitialized(firstCommand.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "task_notification_steer" : "task_notification";
  this.messageHistory.addUser(
    blocks ? blocks.map((block) => ({ type: "text" as const, text: block })) : text,
    runtimeInputMetadata(inputPresentation),
  );
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: {
      inputPresentation,
      ...(originMeta ? { originMeta } : {}),
      visibility: "model-only",
    },
    sessionId: this.sessionId,
    source: "background_task",
    text: blocks ?? text,
    traceContext: firstCommand.traceContext,
    visibility: "model-only",
  });
  // Outer drain previously persisted each item and started a model turn for each, making request count grow linearly
  // with pending items. Persist one synthetic message for the batch while still settling each ledger identity individually.
  for (const command of commands) {
    await this.sessionStore
      ?.markSessionInputPromoted?.({
        id: String(command.id),
        sessionID: this.sessionId,
        promotedMessageID: messageID,
      })
      .catch((error) => {
        this.logger?.warn("Failed to mark background notification promoted", {
          ...traceContextToLogContext(command.traceContext),
          commandId: command.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.promote_mark_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  }
  return {
    ...(backgroundSource ? { backgroundSource } : {}),
    messageId: messageID,
    ...(originMeta ? { originMeta } : {}),
    text,
  };
}

/**
 * 入账（saveSessionInput）是异步的，出队丢弃时它可能还没写完：先等它，再结算，否则 settle 落空、
 * 随后写入的 admitted 永远留在账本里。按 runtime 记、入账完成后即删，不随会话增长。
 */
const backgroundNotificationAdmissions = new WeakMap<object, Map<string, Promise<unknown>>>();

function rememberBackgroundNotificationAdmission(
  runtime: AgentRuntimeInternal,
  commandId: string,
  admission: Promise<unknown>,
): void {
  let admissions = backgroundNotificationAdmissions.get(runtime);
  if (!admissions) {
    admissions = new Map();
    backgroundNotificationAdmissions.set(runtime, admissions);
  }
  const pending = admission.catch(() => undefined);
  admissions.set(commandId, pending);
  void pending.then(() => {
    if (admissions.get(commandId) === pending) admissions.delete(commandId);
  });
}

/**
 * 出队丢弃的通知要在账本里结算为 discarded（!3563 评审第四轮 CR-02）：内存命令已移除，留下的
 * admitted 会被会话常驻池当作未处理输入，挡住空闲时的插件自动重载，直到下次 resume 才收口。
 * 结算算作常驻阻塞工作，完成前不会误判空闲。
 */
function settleDroppedBackgroundNotification(
  runtime: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
  reason: string,
): void {
  const settle = runtime.sessionStore?.settleSessionInput;
  if (!settle) return;
  const commandId = String(command.id);
  const work = (async () => {
    // 出队可能就发生在入队的同一同步片里（空闲时入队即开轮），那时 enqueue 还没调用
    // saveSessionInput：让出一个微任务，等入队同步片走完、入账登记好再取。
    await Promise.resolve();
    await backgroundNotificationAdmissions.get(runtime)?.get(commandId);
    await settle.call(runtime.sessionStore, {
      id: commandId,
      sessionID: runtime.sessionId,
      status: "discarded",
      reason,
    });
  })();
  const tracked = runtime.trackResidencyBlockingWork?.(work) ?? work;
  void tracked.catch((error: unknown) => {
    runtime.logger?.warn("Failed to settle dropped background notification", {
      ...traceContextToLogContext(command.traceContext),
      commandId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.settle_failed",
      module: "core.runtime",
      reason,
      status: "failed",
    });
  });
}

export function shouldSuppressTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  const registryTask = command.taskId ? this.runtimeTaskRegistry.get(command.taskId) : undefined;
  // 无进展提醒出队时已不成立（Agent 已结束、有新进展、在等审批或已恢复成新执行）：丢弃。
  // 终态通知会单独送达，模型不会先读到过时的「无进展」。
  const stall = command.originMeta?.subagentStall;
  if (stall !== undefined && !isBackgroundSubagentStallReminderCurrent(registryTask, stall)) {
    this.logger?.info?.("Dropped stale background subagent stall reminder", {
      ...traceContextToLogContext(command.traceContext),
      commandId: command.id,
      event: "runtime.background_task_notification.stall_reminder_stale",
      module: "core.runtime",
      taskId: command.taskId,
      taskStatus: registryTask?.status,
    });
    settleDroppedBackgroundNotification(this, command, "subagent_stall_reminder_stale");
    return true;
  }
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: this.config.taskType === "subagent_child",
      notificationSealed: this.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: command.toolName,
    })
  ) {
    return false;
  }

  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(command.traceContext),
    commandId: command.id,
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: command.taskId,
    toolName: command.toolName,
  });
  settleDroppedBackgroundNotification(this, command, "subagent_notifications_sealed");
  return true;
}

const SUBAGENT_DISPATCH_TOOL_NAMES = new Set(["Agent", "Task"]);
const BACKGROUND_LAUNCH_ACK_PREFIX = "Async agent launched successfully.";
const PREVIOUS_RUNTIME_EXIT_REASON = "the ZCode runtime process exited before it finished";
// 只认 `<task-notification>` 块里的 task-id：无进展提醒（`<background-agent-stall>`）也带同一个
// task-id，但它不是终态通知，不能让崩溃前收到过提醒的 Agent 被当成「已通知」。
const TASK_NOTIFICATION_ID_PATTERN =
  /<task-notification>(?:(?!<\/task-notification>)[\s\S])*?<task-id>([^<]+)<\/task-id>/g;

/**
 * 上一代 runtime 进程退出时仍在后台运行、且没有交回结果的 Agent，汇总成给模型的提醒正文。
 *
 * 背景：同一个 workspace 的父会话与全部后台 Agent 跑在同一个进程里，进程崩溃（如系统内存耗尽）
 * 后 child 随之结束，却没有 task-notification；模型只看到「已在后台启动」，会一直等或自己排查。
 * 这里在父会话恢复时对账：launch ACK 早于本进程启动、本进程 registry 没有该任务、transcript
 * 里没有它的通知、输出目录的 metadata.json 仍是 running、child 在本进程启动后没有落盘、child 也
 * 没有终态——才判为被中断。
 *
 * 修复原因（!3562 评审 CR-01）：正常关闭时 runtime 会统一停止后台 Agent，失败的 Agent 也已有终态，
 * 只是通知在关闭或崩溃前没送达。最初只看「通知是否送达」，会把这些也报成「进程意外退出」，覆盖
 * 真实的停止者和错误原因。区分两者的持久化事实是 metadata.json：SubagentStopped 只在进程内存的
 * event store 里，新进程读不到。
 *
 * 通知按「最近一次运行」去重（!3562 评审第二轮 CR-02）：SendMessage 恢复沿用同一个 agentId，
 * 之前那次运行的完成通知还在 transcript 里；只有晚于 metadata.json 里 resumedAt 的通知才算这次
 * 运行已经通知过，否则恢复后的运行崩溃会被旧通知挡掉。
 * 正文沿用标准 local_agent 通知（status=failed），由下一轮请求前作为 task_status 提醒落盘送达；
 * 恢复本身不开新轮，打开旧会话不消耗 token，也不在内存仍紧张时立刻重新派发。
 */
export async function collectPreviousRuntimeAgentInterruptions(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  runtimeStartedAt: number = performance.timeOrigin,
): Promise<string | undefined> {
  if (!this.sessionStore) return undefined;
  // taskId → 最近一条通知（含本对账自己落盘的提醒）的写入时间。
  const lastNotifiedAt = new Map<string, number>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      for (const match of part.text.matchAll(TASK_NOTIFICATION_ID_PATTERN)) {
        const taskId = match[1]?.trim();
        if (!taskId) continue;
        lastNotifiedAt.set(
          taskId,
          Math.max(lastNotifiedAt.get(taskId) ?? 0, message.info.time.created),
        );
      }
    }
  }

  const notifications: string[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool" || !SUBAGENT_DISPATCH_TOOL_NAMES.has(part.tool)) continue;
      if (part.state.status !== "completed") continue;
      const output = part.state.output;
      if (typeof output !== "string" || !output.startsWith(BACKGROUND_LAUNCH_ACK_PREFIX)) continue;
      const agentId = output.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1];
      if (!agentId || part.state.time.start >= runtimeStartedAt) continue;
      if (this.runtimeTaskRegistry.get(agentId)) continue;
      // 取到行尾：Windows 的用户目录可能带空格。
      const outputFile = output.match(/(?:^|\n)output_file:[ \t]*([^\r\n]+)/)?.[1]?.trim();
      // 已写下终态（完成、失败、被停止，含正常关闭时的统一停止）：不是被崩溃中断的。
      // 读不到 metadata.json（旧版本、目录被清理）时退回下面按 child 会话判断。
      const run = await readSubagentRunMetadata({
        agentId,
        outputFile,
        outputRootDir: this.config.subagents?.outputRootDir,
        parentSessionId: this.sessionId,
      });
      // 已通知过：通知晚于最近一次恢复（没有恢复记录时任何通知都算）。
      const notifiedAt = lastNotifiedAt.get(agentId);
      if (
        notifiedAt !== undefined &&
        (run?.resumedAt === undefined || notifiedAt >= run.resumedAt)
      ) {
        continue;
      }
      if (run !== undefined && run.status !== "running") continue;
      const metadata = { ...(part.metadata ?? {}), ...(part.state.metadata ?? {}) } as Record<
        string,
        unknown
      >;
      const childSessionId =
        typeof metadata.childSessionId === "string"
          ? metadata.childSessionId
          : createSessionId(`subagent_${agentId}`);
      const child = await this.sessionStore.getSession(childSessionId as SessionId);
      // child 在本进程启动后仍有落盘：另一个进程正在运行它，不是遗留。
      if (!child || child.time.updated >= runtimeStartedAt) continue;
      if (childHasTerminalOutcome(await this.sessionStore.messages({ sessionID: child.id }))) {
        continue;
      }
      const input = part.state.input as Record<string, unknown>;
      notifications.push(
        formatLocalAgentTaskNotification({
          agentId,
          description:
            typeof input.description === "string" && input.description.trim()
              ? input.description
              : "Subagent",
          error: PREVIOUS_RUNTIME_EXIT_REASON,
          outputFile: outputFile ?? "",
          parentToolCallId: part.callID,
          status: "failed",
        }),
      );
    }
  }
  if (notifications.length === 0) return undefined;
  return [
    "The previous ZCode runtime process for this workspace exited unexpectedly (for example, because the system ran out of memory).",
    `${notifications.length === 1 ? "This background agent was" : "These background agents were"} still running and stopped with it. ${notifications.length === 1 ? "It" : "They"} will not report back.`,
    "Before relaunching, check what each agent already changed, then decide whether the work still needs to run. Tell the user if they are waiting on it.",
    "",
    ...notifications,
  ].join("\n");
}

/**
 * 与 sessions 查询（subagent-session-query.ts 的 lastChildOutcome）同一判据：最后一条 assistant
 * 带错误（失败、取消），或不含工具调用且已完成，就是终态。stream recovery 作废的半截回复不算，
 * 子会话会从锚点重发。进程崩溃时最后一条停在工具调用或流式输出中，没有错误也没有完成标记。
 */
function childHasTerminalOutcome(messages: readonly MessageWithParts[]): boolean {
  const last = messages.findLast((message) => message.info.role === "assistant");
  if (!last || last.info.role !== "assistant") return false;
  if (last.info.error) return last.info.error.name !== STREAM_RECOVERY_DISCARDED_ERROR_NAME;
  if (last.parts.some((part) => part.type === "tool")) return false;
  return Boolean(last.info.time.completed || last.info.finish);
}
