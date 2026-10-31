import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { incognitoExcludes } from "@zcode/shared";

import type { BackgroundTaskPayloadBase, ModelTextContentBlock } from "@zcode/contracts";
import type { Model, ModelInputMessage, SessionInfo, TraceContext } from "../deps.js";
import { SessionEventType, traceContextToLogContext } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  acquireDreamLock,
  type DreamLockLease,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
  writeDreamConsolidatedAt,
} from "../../memory/dream.js";
import type { DreamJournalTrigger } from "../../memory/dream-journal/index.js";
import {
  beginDreamJournalRunSafely,
  countDreamJournalActions,
  finalizeDreamJournalSafely,
  logDreamSkip,
  recordDreamSkip,
  snapshotBeforeTouchSafely,
  type DreamSkipReasonCode,
} from "../../memory/dream-journal/index.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveMainAgentSystemPromptOverrides } from "../methods/context.js";
import {
  prepareProjectMemoryAgentRequest,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  recordProjectMemoryAgentModelUsageFact,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { invalidateProjectMemoryRecallPaths } from "./project-memory-recall.js";
import { isMainMemoryTaskType, resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const AUTO_DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 5;
const MANUAL_DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 1;
const DREAM_MAX_TURNS = 50;

export type ProjectMemoryDreamSkipReason =
  | "memory-disabled"
  | "remote-workspace"
  | "lock-held"
  | "no-fresh-transcripts"
  /** Auto-mode only: the 24h minimum interval or the 10-minute scan throttle closed the window. */
  | "auto-timing";

export type ProjectMemoryDreamOutcome =
  | { status: "consolidated"; summary: string; touchedPaths: readonly string[] }
  | { status: "skipped"; reason: ProjectMemoryDreamSkipReason }
  | { status: "failed"; error: unknown };

export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}

export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    // An incognito session without memory must never feed another session's dream.
    if (incognitoExcludes(session.incognito, "memory")) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

// 当前产品链路不自动触发 Dream；保留可等待的 handler，待 project transcript 隔离方案确定后再接线。
export async function runProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): Promise<void> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;
  if (!runtime.modelIoDir) return;

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  await executeProjectMemoryDream(runtime, context, { mode: "auto" });
}

/** Registry description + first progress line for a background dream run. */
const DREAM_BACKGROUND_TASK_DESCRIPTION = "Consolidating project memory…";

/**
 * Manual `/dream` launch result: synchronous skips stay visible in the launch turn; a started run
 * detaches from the turn and settles through the runtime task registry + BackgroundTask* events.
 * `completion` never rejects — it always resolves to the run outcome.
 */
export type ManualDreamLaunch =
  | { status: "skipped"; reason: ProjectMemoryDreamSkipReason }
  | { status: "started"; taskId: string; completion: Promise<ProjectMemoryDreamOutcome> };

/** Manual `/dream` command path: every skip is a visible outcome, the run itself is detached. */
export async function launchManualProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { model?: Model; traceContext: TraceContext },
): Promise<ManualDreamLaunch> {
  if (runtime.shuttingDown) throw new Error("Runtime is shutting down");
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot || !runtime.sessionStore || !runtime.fileSystemPort || !runtime.modelIoDir) {
    // No memory root exists to hold a journal row, so this skip is logged only.
    logDreamSkip(runtime, input.traceContext, "manual", "disabled");
    return { status: "skipped", reason: "memory-disabled" };
  }
  // Remote workspaces own no local memory root, so their skip is logged but not journaled here.
  if (runtime.isRemoteWorkspace()) {
    logDreamSkip(runtime, input.traceContext, "manual", "remote");
    return { status: "skipped", reason: "remote-workspace" };
  }

  if (runtime.backgroundDreamRuns.size > 0) {
    await recordDreamSkip(runtime, {
      memoryRoot,
      traceContext: input.traceContext,
      trigger: "manual",
      reasonCode: "lock_held",
    });
    return { status: "skipped", reason: "lock-held" };
  }
  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  const slot = await acquireDreamRunSlot(runtime, context, { mode: "manual" });
  if (slot.kind === "skip") {
    return { status: "skipped", reason: slot.reason };
  }

  const taskId = `dream-${randomUUID()}`;
  const controller = new AbortController();
  let settle!: (outcome: ProjectMemoryDreamOutcome) => void;
  const completion = new Promise<ProjectMemoryDreamOutcome>((resolve) => {
    settle = resolve;
  });
  let eventChain = Promise.resolve();
  let terminal = false;
  let lastProgress = DREAM_BACKGROUND_TASK_DESCRIPTION;
  const enqueue = (
    type: DreamBackgroundEventType,
    payload: Omit<BackgroundTaskPayloadBase, "taskId" | "taskKind">,
  ): Promise<void> => {
    eventChain = eventChain
      .then(() =>
        emitDreamBackgroundTaskEvent(runtime, type, {
          taskId,
          taskKind: "dream",
          ...payload,
        }),
      )
      .catch((error: unknown) => {
        logDreamFailure(runtime, "Dream lifecycle event write failed", error);
      });
    return eventChain;
  };
  const requestCancel = (): Promise<void> => {
    if (terminal || controller.signal.aborted) return eventChain;
    controller.abort();
    return enqueue(SessionEventType.BackgroundTaskUpdated, {
      cancelRequestedAt: new Date(),
      cancellable: false,
      description: lastProgress,
      status: "running",
    });
  };

  try {
    if (runtime.shuttingDown) throw new Error("Runtime is shutting down");
    runtime.backgroundDreamRuns.set(taskId, { controller, completion, requestCancel });
    runtime.runtimeTaskRegistry.register({
      taskId,
      agentId: taskId,
      agentType: "dream",
      description: DREAM_BACKGROUND_TASK_DESCRIPTION,
      status: "running",
      startedAt: new Date(),
      isBackgrounded: true,
      type: "local_dream",
      parentSessionId: runtime.sessionId,
      traceContext: context.traceContext,
    });
    await emitDreamBackgroundTaskEvent(runtime, SessionEventType.BackgroundTaskStarted, {
      taskId,
      taskKind: "dream",
      cancellable: true,
      description: DREAM_BACKGROUND_TASK_DESCRIPTION,
      status: "running",
    });
  } catch (error) {
    logDreamFailure(runtime, "Dream launch failed", error);
    await enqueue(SessionEventType.BackgroundTaskCompleted, {
      status: "failed",
      cancellable: false,
      description: "Dream failed to start",
      completedAt: new Date(),
    });
    await restoreDreamSlot(runtime, context.memoryRoot, slot.lease);
    runtime.backgroundDreamRuns.delete(taskId);
    runtime.runtimeTaskRegistry.remove(taskId);
    settle({ status: "failed", error });
    throw error;
  }

  const run = async (): Promise<ProjectMemoryDreamOutcome> => {
    let outcome: Exclude<ProjectMemoryDreamOutcome, { status: "skipped" }>;
    let status: "completed" | "failed" | "cancelled" = "failed";
    try {
      const telemetry = runtime.agentTelemetry.detached({
        causation: context.causation,
        executionKind: "background",
        operation: "project_memory_dream",
        targetKind: "project_memory",
        traceContext: context.traceContext,
        trigger: "user",
      });
      outcome = await telemetry.run(() =>
        runDreamConsolidation(runtime, context, {
          abortSignal: controller.signal,
          trigger: "manual",
          onActivity: (activity) => {
            if (terminal || controller.signal.aborted || activity === lastProgress) return;
            lastProgress = activity;
            runtime.runtimeTaskRegistry.update(taskId, (task) => ({
              ...task,
              description: activity,
            }));
            void enqueue(SessionEventType.BackgroundTaskUpdated, {
              cancellable: true,
              description: activity,
              status: "running",
            });
          },
          lease: slot.lease,
          transcriptSessionIds: slot.transcriptSessionIds,
        }),
      );
      status =
        outcome.status === "consolidated"
          ? "completed"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
      if (outcome.status === "consolidated") telemetry.finishCompleted();
      else if (status === "cancelled")
        telemetry.finishCancelled(runtime.shuttingDown ? "shutdown" : "user");
      else telemetry.finishFailed("execute", "internal", outcome.error);
    } catch (error) {
      logDreamFailure(runtime, "Dream background execution failed", error);
      await restoreDreamSlot(runtime, context.memoryRoot, slot.lease);
      outcome = { status: "failed", error };
      status = controller.signal.aborted ? "cancelled" : "failed";
    }
    terminal = true;
    try {
      await enqueue(SessionEventType.BackgroundTaskCompleted, {
        cancellable: false,
        completedAt: new Date(),
        description:
          outcome.status === "consolidated"
            ? dreamCompletedDescription(outcome.summary)
            : status === "cancelled"
              ? "Dream cancelled"
              : "Dream failed",
        status,
      });
      // The completion notification is the durable transcript carrier, the CLI TUI completion
      // surface, and the delivery channel that clears the panel's resultPending entry. A
      // user-initiated cancel needs no turn: they already saw the stop land.
      if (status !== "cancelled") {
        runtime.enqueueBackgroundTaskNotification({
          originMeta: {
            backgroundSource: "dream",
            title: dreamNotificationTitle(outcome),
            workId: taskId,
          },
          taskId,
          text: dreamNotificationText(outcome),
          traceContext: runtime.rootTraceContext,
        });
      }
      return outcome;
    } finally {
      // Keep residency until all ordered event writes have settled.
      runtime.runtimeTaskRegistry.update(taskId, (task) => ({
        ...task,
        completedAt: new Date(),
        status,
      }));
      runtime.backgroundDreamRuns.delete(taskId);
    }
  };
  // Attach both handlers immediately; callers never inherit a detached rejection.
  void run().then(settle, (error: unknown) => {
    logDreamFailure(runtime, "Dream settlement failed", error);
    runtime.backgroundDreamRuns.delete(taskId);
    runtime.runtimeTaskRegistry.update(taskId, (task) => ({
      ...task,
      status: "failed",
      completedAt: new Date(),
    }));
    settle({ status: "failed", error });
  });
  return { status: "started", taskId, completion };
}

export interface BackgroundDreamRun {
  controller: AbortController;
  completion: Promise<ProjectMemoryDreamOutcome>;
  requestCancel: () => Promise<void>;
}

/** Called before closing stores so cancellation can still persist its terminal event. */
export async function drainBackgroundDreams(
  this: AgentRuntimeInternal,
  timeoutMs = 60_000,
): Promise<void> {
  const completions = [...this.backgroundDreamRuns.values()].map((run) => run.completion);
  if (completions.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(completions),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.logger?.warn("Dream shutdown drain timed out", {
            event: "memory.dream.drain_timeout",
          });
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function restoreDreamSlot(
  runtime: AgentRuntimeInternal,
  memoryRoot: string,
  lease: DreamLockLease,
): Promise<void> {
  try {
    await restoreDreamLockAfterFailure({ memoryRoot, lease });
  } catch (error) {
    logDreamFailure(runtime, "Dream lock restore failed", error);
  }
}

function logDreamFailure(
  runtime: AgentRuntimeInternal,
  message: string,
  error: unknown,
  fields: { phase?: DreamFailurePhase; runId?: string } = {},
): void {
  runtime.logger?.warn(message, {
    event: "memory.dream.failed",
    errorMessage: error instanceof Error ? error.message : String(error),
    module: "core.runtime",
    status: "failed",
    ...fields,
  });
}

export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

type DreamRunSlot =
  | { kind: "skip"; reason: ProjectMemoryDreamSkipReason }
  | { kind: "ready"; transcriptSessionIds: string[]; lease: DreamLockLease };

/** Shared gate phase: timing (auto), transcript freshness, and lock acquisition. */
async function acquireDreamRunSlot(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  options: { mode: "auto" | "manual" },
): Promise<DreamRunSlot> {
  const nowMs = runtime.now().getTime();
  const trigger = dreamJournalTrigger(options.mode);
  const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(context.memoryRoot);
  if (options.mode === "auto") {
    const timing = evaluateAutoDreamTiming({
      lastConsolidatedAtMs,
      lastScanAtMs: runtime.memoryDreamLastScanAtMs,
      nowMs,
    });
    if (timing.decision === "skip") {
      return skipDreamRun(runtime, context, {
        trigger,
        reason: "auto-timing",
        reasonCode: timing.reason === "minimum-interval" ? "min_interval" : "scan_throttled",
      });
    }
    runtime.memoryDreamLastScanAtMs = nowMs;
  }
  const sessions = selectProjectDreamSessions({
    currentSessionId: runtime.sessionId,
    sessions: await runtime.sessionStore!.listSessions(),
    workspacePath: context.workspaceRoot,
    workspaceIdentity: runtime.config.memory?.workspaceIdentity,
  });
  const transcriptSessionIds = await recentModelIoSessionIds(
    runtime,
    sessions,
    context,
    lastConsolidatedAtMs,
  );
  const minimumTranscriptSessions =
    options.mode === "manual"
      ? MANUAL_DREAM_MINIMUM_TRANSCRIPT_SESSIONS
      : AUTO_DREAM_MINIMUM_TRANSCRIPT_SESSIONS;
  if (transcriptSessionIds.length < minimumTranscriptSessions) {
    return skipDreamRun(runtime, context, {
      trigger,
      reason: "no-fresh-transcripts",
      reasonCode: transcriptSessionIds.length === 0 ? "no_new_turns" : "too_few_sessions",
    });
  }

  const lease = await acquireDreamLock({ memoryRoot: context.memoryRoot, nowMs });
  if (lease === null) {
    return skipDreamRun(runtime, context, { trigger, reason: "lock-held", reasonCode: "lock_held" });
  }
  return { kind: "ready", transcriptSessionIds, lease };
}

function dreamJournalTrigger(mode: "auto" | "manual"): DreamJournalTrigger {
  return mode === "auto" ? "scheduled" : "manual";
}

async function skipDreamRun(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  input: {
    trigger: DreamJournalTrigger;
    reason: ProjectMemoryDreamSkipReason;
    reasonCode: DreamSkipReasonCode;
  },
): Promise<DreamRunSlot> {
  await recordDreamSkip(runtime, {
    memoryRoot: context.memoryRoot,
    traceContext: context.traceContext,
    trigger: input.trigger,
    reasonCode: input.reasonCode,
  });
  return { kind: "skip", reason: input.reason };
}

/** Shared run phase: prompt → Memory agent loop → usage facts → pending update → marker. */
async function runDreamConsolidation(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  input: {
    abortSignal?: AbortSignal;
    onActivity?: (activity: string) => void;
    lease: DreamLockLease;
    transcriptSessionIds: string[];
    trigger: DreamJournalTrigger;
  },
): Promise<Exclude<ProjectMemoryDreamOutcome, { status: "skipped" }>> {
  // The lock is already held here, so the journal run starts only after the single-writer gate.
  const startedAtMs = Date.now();
  const journal = await beginDreamJournalRunSafely(runtime, context, input.trigger);
  const runId = journal?.id;
  runtime.logger?.info("Dream run started", {
    ...traceContextToLogContext(context.traceContext),
    event: "memory.dream.run.started",
    module: "core.runtime",
    runId,
    sessionCount: input.transcriptSessionIds.length,
    status: "started",
    trigger: input.trigger,
  });

  let phase: DreamFailurePhase = "prepare";
  try {
    const prompt = buildMemoryDreamPrompt({
      memoryRoot: context.memoryRoot,
      override: resolveMainAgentSystemPromptOverrides(runtime.config)?.["memory-dream"],
      sessionIds: input.transcriptSessionIds,
      transcriptRoot: runtime.modelIoDir!,
    });
    const request = prepareProjectMemoryAgentRequest(context, prompt);
    const executor = createProjectMemoryAgentToolExecutor(runtime, context);
    const touchedPaths = new Set<string>();

    phase = "agent_loop";
    const loopResult = await runMemoryAgentLoop({
      abortSignal: input.abortSignal,
      executeTool: async (toolCall, loopOptions) => {
        const callPaths = new Set<string>();
        collectDreamTouchedPaths(callPaths, {
          rootDir: context.memoryRoot,
          toolCall,
          workingDirectory: context.workingDirectory,
          workspaceRoot: context.workspaceRoot,
        });
        // The snapshot must be durable before the tool runs, so a crash mid-tool still leaves
        // the pre-change state on record.
        for (const filePath of callPaths) {
          touchedPaths.add(filePath);
          await snapshotBeforeTouchSafely(runtime, context, journal, filePath);
        }
        input.onActivity?.(describeDreamToolActivity(toolCall));
        return executor.execute(toolCall, {
          signal: loopOptions.abortSignal,
          traceContext: context.traceContext,
        });
      },
      onRequestStart: (index) => input.onActivity?.(`Model request ${index + 1}…`),
      onRequestSettled: (request) =>
        recordProjectMemoryAgentModelUsageFact(runtime, context, request, "dream"),
      maxTurns: DREAM_MAX_TURNS,
      request,
      model: context.model,
      rootDir: context.memoryRoot,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    // Cancellation before this commit boundary must not stamp a successful consolidation.
    input.abortSignal?.throwIfAborted();

    // The journal is finalized before the lock marker is stamped, so the run record is on disk
    // before the run reads as consolidated. A failed finalize is logged by the adapter as
    // memory.dream.journal.failed and returns undefined; the run still stamps the lock, because
    // the journal must never fail the Dream run.
    phase = "commit";
    const run = await finalizeDreamJournalSafely(runtime, context, journal, {
      status: "succeeded",
    });
    const paths = [...touchedPaths];
    if (paths.length > 0) {
      runtime.pendingMemoryUpdate = createProjectMemoryUpdate(runtime, paths);
      invalidateProjectMemoryRecallPaths(runtime, paths);
    }
    await writeDreamConsolidatedAt(context.memoryRoot, input.lease);
    runtime.logger?.info("Dream run completed", {
      ...traceContextToLogContext(context.traceContext),
      durationMs: Date.now() - startedAtMs,
      event: "memory.dream.run.completed",
      module: "core.runtime",
      outcome: run?.outcome,
      runId,
      status: "completed",
      ...(run ? countDreamJournalActions(run) : {}),
    });
    return {
      status: "consolidated",
      summary: finalAssistantText(loopResult.messages) ?? memoryUpdateSummary(paths),
      touchedPaths: paths,
    };
  } catch (error) {
    logDreamFailure(runtime, "Dream consolidation failed", error, { phase, runId });
    await finalizeDreamJournalSafely(runtime, context, journal, {
      status: "failed",
      reasonCode: input.abortSignal?.aborted
        ? "aborted"
        : phase === "commit"
          ? "commit_failed"
          : "error",
    });
    await restoreDreamSlot(runtime, context.memoryRoot, input.lease);
    return { status: "failed", error };
  }
}

type DreamFailurePhase = "prepare" | "agent_loop" | "commit";

async function executeProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  options: { abortSignal?: AbortSignal; mode: "auto" | "manual" },
): Promise<ProjectMemoryDreamOutcome> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: context.causation,
    executionKind: "background",
    operation: "project_memory_dream",
    targetKind: "project_memory",
    traceContext: context.traceContext,
    trigger: options.mode === "manual" ? "user" : "scheduler",
  });

  return telemetry.run(async (): Promise<ProjectMemoryDreamOutcome> => {
    const slot = await acquireDreamRunSlot(runtime, context, { mode: options.mode });
    if (slot.kind === "skip") {
      telemetry.setResultType("metadata");
      telemetry.finishCompleted();
      return { status: "skipped", reason: slot.reason };
    }
    const outcome = await runDreamConsolidation(runtime, context, {
      abortSignal: options.abortSignal,
      lease: slot.lease,
      trigger: dreamJournalTrigger(options.mode),
      transcriptSessionIds: slot.transcriptSessionIds,
    });
    if (outcome.status === "failed") {
      telemetry.finishFailed("execute", "internal", outcome.error);
    } else {
      telemetry.finishCompleted();
    }
    return outcome;
  });
}

/**
 * Out-of-turn BackgroundTask* append for the detached dream run. Uses rootTraceContext with an
 * empty turnId (same reasoning as dynamic-workflow-run-progress.ts): the event belongs to the
 * background run, not to whichever turn happens to be active when it is emitted.
 */
type DreamBackgroundEventType =
  | typeof SessionEventType.BackgroundTaskStarted
  | typeof SessionEventType.BackgroundTaskUpdated
  | typeof SessionEventType.BackgroundTaskCompleted;

async function emitDreamBackgroundTaskEvent(
  runtime: AgentRuntimeInternal,
  type: DreamBackgroundEventType,
  payload: BackgroundTaskPayloadBase,
): Promise<void> {
  const traceContext = runtime.rootTraceContext;
  await runtime.appendEvent(runtime.createEvent(type, payload, traceContext), traceContext);
}

/** One-line activity label surfaced as the backgroundWorks panel title while the run progresses. */
function describeDreamToolActivity(toolCall: { name: string; input?: unknown }): string {
  const input = toolCall.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return toolCall.name;
  const record = input as Record<string, unknown>;
  const target = [record.file_path, record.command, record.pattern, record.path, record.query].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return target === undefined ? toolCall.name : `${toolCall.name} ${target}`.slice(0, 120);
}

/** Per-request `model_usage` facts for the dream loop (title-sidecar pattern, querySource "dream"). */
/** First line of the agent summary, capped for the completed panel entry. */
function dreamCompletedDescription(summary: string): string {
  const firstLine = summary.split("\n", 1)[0] ?? "";
  return firstLine.length > 0 ? firstLine.slice(0, 120) : "Dream completed";
}

/** One-line title for the background-result turn header (CLI-authored, not localized). */
function dreamNotificationTitle(
  outcome: Exclude<ProjectMemoryDreamOutcome, { status: "skipped" }>,
): string {
  return outcome.status === "consolidated"
    ? `Dream: ${dreamCompletedDescription(outcome.summary)}`.slice(0, 120)
    : "Dream failed";
}

/** Model-visible completion notice; the reply turn is the durable transcript row. */
function dreamNotificationText(
  outcome: Exclude<ProjectMemoryDreamOutcome, { status: "skipped" }>,
): string {
  if (outcome.status === "consolidated") {
    const filesLine =
      outcome.touchedPaths.length > 0 ? `\nFiles changed: ${outcome.touchedPaths.join(", ")}` : "";
    return `Background memory consolidation (dream) finished.\n${outcome.summary}${filesLine}`;
  }
  const message =
    outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "");
  return `Background memory consolidation (dream) failed${message ? `: ${message}` : ""}.`;
}

/** Last non-empty assistant text from the Memory agent loop, or undefined when the loop ended without one. */
function finalAssistantText(messages: readonly ModelInputMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block): block is ModelTextContentBlock => block.type === "text")
            .map((block) => block.text)
            .join("");
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

async function recentModelIoSessionIds(
  runtime: AgentRuntimeInternal,
  sessions: readonly SessionInfo[],
  context: ProjectMemoryAgentContext,
  lastConsolidatedAtMs: number,
): Promise<string[]> {
  const sessionIds = await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await runtime.fileSystemPort!.stat({
          path: join(runtime.modelIoDir!, `model-io-${session.id}.jsonl`),
          trace: context.traceContext,
        });
        // 修复原因：gate 以真实 transcript mtime 为准；SessionStore.updated 只描述
        // durable session，不能代替 transcript 是否在上次 consolidation 后发生变化。
        return result.kind === "file" &&
          result.mtimeMs !== undefined &&
          result.mtimeMs > lastConsolidatedAtMs
          ? String(session.id)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return sessionIds.filter((sessionId): sessionId is string => sessionId !== undefined);
}

function createProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
  paths: string[],
): ProjectMemoryUpdate {
  const inContextPaths = paths.filter(
    (path) =>
      basename(path) === "MEMORY.md" ||
      runtime.memoryRecallState.recalledPaths.has(path) ||
      findLatestReadFileState(runtime.readFileState, path) !== undefined,
  );
  return {
    inContextPaths,
    paths,
    source: "dream",
    summary: memoryUpdateSummary(paths),
  };
}

/** Wording is pinned by the frozen memory-update fixture; keep it byte-identical. */
function memoryUpdateSummary(paths: readonly string[]): string {
  return `consolidated ${paths.length} memory file${paths.length === 1 ? "" : "s"}`;
}

function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}
