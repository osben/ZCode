import {
  SessionEventType,
  traceContextToLogContext,
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunStopReason,
  type ExecutionPort,
  type SessionEvent,
  type DynamicWorkflowRunSnapshot,
  type SubagentTaskSnapshot,
  type TraceContext,
  type TurnId,
  type WorkflowNotificationMeta,
  type WorkflowTaskSnapshot,
} from "@zcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  registerRuntimeBackgroundTask,
  releaseRuntimeBackgroundTaskNotification,
  removeRuntimeBackgroundTask,
  updateRuntimeBackgroundTask,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import {
  buildWorkflowReportsManifestSection,
  buildWorkflowReportsNotificationSection,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
// Two artifacts: the one above is the script's **top-level return value** (the engine-internal
// `RunSettlement.artifact`, shown in `<result>`); the one below is output the script **publishes
// for the user** through `artifact.*` (shown in `<artifacts>`). Both appear side by side in the
// same completion notification, so keep them as separate fields.
import {
  buildWorkflowArtifactsManifestSection,
  buildWorkflowArtifactsNotificationSection,
  toPublishedArtifactSummaries,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";

type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // The workflow-run snapshot keeps the WorkflowTaskSnapshot shape but widens output to unknown
  // (the artifact comes from the script's top-level return value), so it is not a subtype of
  // WorkflowTaskSnapshot and needs its own union branch.
  | DynamicWorkflowRunSnapshot;

type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

type WorkflowTaskWaiter = {
  waitForTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

/**
 * Background lifecycle provider for a tool. If these five concerns are scattered across five
 * `if (toolCall.name === …)` checks, every new background tool requires updating all five. A
 * missed hard-coded false in `canCancelBackgroundTask` for legacy `Workflow` is a concrete
 * example: it makes cancellable permanently false in the started payload and disables the
 * cancellation entry point. Look up this structure once by tool name, then each of the five
 * dispatch sites only reads its fields.
 *
 * Defaults (fields absent) exactly preserve the previous behavior: no getSnapshot means no
 * snapshot provider (no 1s polling); no waitForTerminal means no direct waiter; cancellable
 * defaults to false.
 */
interface BackgroundTaskLifecycleProvider {
  /** Snapshot source polled every second. */
  getSnapshot?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** Direct waiter for terminal state (faster than polling, and the only terminal-state source when polling is absent). */
  waitForTerminal?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** Whether the user can cancel a running task; determines `cancellable` in started/updated payloads. */
  cancellable?: boolean;
}

export class BackgroundTaskTracker {
  private readonly backgroundPollers = new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  async trackBackgroundTask(
    toolCall: ExecutableToolCall,
    output: unknown,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    if (!isRecord(output)) return;
    if (!isBackgroundTaskLaunch(toolCall, output)) return;
    const taskId =
      typeof output.backgroundTaskId === "string"
        ? output.backgroundTaskId
        : typeof output.agentId === "string"
          ? output.agentId
          : undefined;
    if (!taskId || this.backgroundPollers.has(taskId)) return;

    this.backgroundPollers.add(taskId);
    registerRuntimeBackgroundTask(this.deps, toolCall, taskId, output, turnId);
    try {
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskStarted,
        this.backgroundTaskPayload(toolCall, taskId, "running", undefined, output),
        traceContext,
        turnId,
      );
    } catch (error) {
      this.backgroundPollers.delete(taskId);
      removeRuntimeBackgroundTask(this.deps, toolCall, taskId);
      throw error;
    }

    const hasSnapshotProvider = this.hasBackgroundTaskSnapshotProvider(toolCall);
    const hasDirectWaiter = this.hasDirectBackgroundTaskWaiter(toolCall);
    this.deps.logger?.info?.("Background task tracking started", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.started",
      hasDirectWaiter,
      hasSnapshotProvider,
      module: "core.tool.executor",
      taskId,
      toolName: toolCall.name,
    });

    if (!hasSnapshotProvider && !hasDirectWaiter) {
      this.deps.logger?.info?.("Background task tracking lost without snapshot source", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.lost",
        module: "core.tool.executor",
        reason: "missing_snapshot_source",
        taskId,
        toolName: toolCall.name,
      });
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
      this.maybeEnqueueBackgroundTaskNotification(
        toolCall,
        taskId,
        "lost",
        undefined,
        traceContext,
        output,
      );
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
        traceContext,
        turnId,
      );
      this.backgroundPollers.delete(taskId);
      return;
    }

    let lastSnapshotSignature = "";
    let completing = false;
    let polling = false;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

    const stopTracking = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      maxRuntimeTimer = undefined;
      this.backgroundPollers.delete(taskId);
    };

    if (
      toolCall.name === "Bash" &&
      this.deps.runtimeScope === "subagent" &&
      this.deps.subagentBackgroundBashMaxMs !== undefined &&
      this.deps.executionPort?.cancelBackgroundTask
    ) {
      maxRuntimeTimer = setTimeout(() => {
        this.deps.logger?.warn("Subagent background Bash exceeded max runtime; cancelling", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.subagent_bash.max_runtime_exceeded",
          module: "core.tool.executor",
          taskId,
          toolName: toolCall.name,
        });
        void Promise.resolve(
          this.deps.executionPort?.cancelBackgroundTask?.(taskId),
        ).catch((error) => {
          this.deps.logger?.warn("Subagent background Bash cancellation failed", {
            ...traceContextToLogContext(traceContext),
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "background_task.subagent_bash.cancel_failed",
            module: "core.tool.executor",
            taskId,
            toolName: toolCall.name,
          });
        });
      }, this.deps.subagentBackgroundBashMaxMs);
    }

    const emitRunningUpdate = async (snapshot: BackgroundTaskSnapshot) => {
      const signature = this.backgroundSnapshotSignature(snapshot);
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskUpdated,
        this.backgroundTaskPayload(toolCall, taskId, "running", snapshot, output),
        traceContext,
        turnId,
      );
    };

    const emitTerminalSnapshot = async (
      snapshot: BackgroundTaskSnapshot | undefined,
    ): Promise<void> => {
      if (stopped || completing) return;
      completing = true;
      try {
        if (!snapshot) {
          this.deps.logger?.info?.("Background task terminal snapshot missing", {
            ...traceContextToLogContext(traceContext),
            event: "background_task.tracking.lost",
            module: "core.tool.executor",
            reason: "snapshot_missing",
            taskId,
            toolName: toolCall.name,
          });
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
          this.maybeEnqueueBackgroundTaskNotification(
            toolCall,
            taskId,
            "lost",
            undefined,
            traceContext,
            output,
          );
          await this.emitBackgroundTaskEvent(
            SessionEventType.BackgroundTaskCompleted,
            this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
            traceContext,
            turnId,
          );
          stopped = true;
          stopTracking();
          return;
        }

        if (snapshot.status === "running") {
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
          await emitRunningUpdate(snapshot);
          if (!hasSnapshotProvider) {
            stopped = true;
            stopTracking();
          }
          return;
        }

        if (this.isNotifiedLocalAgentSnapshot(toolCall, snapshot)) {
          this.deps.logger?.debug?.("Background task terminal notification already handled by subagent", {
            ...traceContextToLogContext(traceContext),
            event: "background_task.tracking.notification_already_handled",
            module: "core.tool.executor",
            taskId,
            toolName: toolCall.name,
          });
          stopped = true;
          stopTracking();
          return;
        }

        this.deps.logger?.info?.("Background task terminal snapshot observed", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.tracking.terminal",
          module: "core.tool.executor",
          taskId,
          taskStatus: snapshot.status,
          toolName: toolCall.name,
        });
        updateRuntimeBackgroundTask(this.deps, toolCall, taskId, snapshot.status, snapshot);
        this.maybeEnqueueBackgroundTaskNotification(
          toolCall,
          taskId,
          snapshot.status,
          snapshot,
          traceContext,
        );
        await this.emitBackgroundTaskEvent(
          SessionEventType.BackgroundTaskCompleted,
          this.backgroundTaskPayload(toolCall, taskId, snapshot.status, snapshot, output),
          traceContext,
          turnId,
        );
        stopped = true;
        stopTracking();
      } finally {
        completing = false;
      }
    };

    const poll = async () => {
      if (polling || stopped || !hasSnapshotProvider) return;
      polling = true;
      try {
        const snapshot = await this.getBackgroundTaskSnapshot(toolCall, taskId);
        if (!snapshot) {
          await emitTerminalSnapshot(undefined);
          return;
        }

        if (snapshot.status === "running") {
          await emitRunningUpdate(snapshot);
          return;
        }

        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task polling failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
      } finally {
        polling = false;
      }
    };

    const waitForCompletion = async () => {
      try {
        const snapshot = await this.waitForBackgroundTaskSnapshot(toolCall, taskId);
        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task wait failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
        if (!hasSnapshotProvider) {
          stopped = true;
          stopTracking();
        }
      }
    };

    if (hasSnapshotProvider) {
      timer = setInterval(() => {
        void poll();
      }, 1_000);
      timer.unref?.();
      await poll();
    }

    if (hasDirectWaiter && !stopped) {
      void waitForCompletion();
    }
  }

  private async emitBackgroundTaskEvent(
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    await this.deps.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: this.deps.sessionId,
      turnId,
      type,
      timestamp: new Date(),
      traceId: traceContext.traceId,
      sequenceNumber: 0,
      payload,
    });
  }

  private backgroundTaskPayload(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot?: BackgroundTaskSnapshot,
    output?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

    return {
      taskId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      // V4 projection previously inferred type by hard-coding toolName checks. It missed the
      // real Agent tool name and projected background subagents as bash/process. The runtime now
      // makes this decision once where the fact is produced.
      // Lifecycle behavior is unaffected; per-tool lifecycleProvider already dispatches it.
      taskKind: backgroundTaskKind(toolCall.name),
      childSessionId: outputMetadata.childSessionId,
      cancellable: status === "running" && this.canCancelBackgroundTask(toolCall),
      command: typeof input.command === "string" ? input.command : undefined,
      // CreateWorkflow's input schema has no `description` (only `{name?, script}`;
      // contracts/src/tools/create-workflow.ts), so the generic input.description →
      // snapshot.description chain leaves the field absent. The Workflows section then falls
      // back to toolName and displays every run as "CreateWorkflow." Display name and completion
      // notification share the same fallback chain (including input.name), so reuse
      // workflowTaskSubject. Its final fallback is taskId (≡ runId): the projection uses it as
      // the title, but the UI treats title ≡ workId as unnamed and uses fallbackName, so users
      // never see this fallback. This preserves the simpler invariant that description is never
      // empty.
      // Extend dwf dispatch to ResumeWorkflowRun: it uses the same fallback chain and also has
      // only run_id, with no description.
      description: isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? workflowTaskSubject(toolCall, taskId, snapshot, output)
        : typeof input.description === "string"
          ? input.description
          : snapshot && "description" in snapshot
            ? snapshot.description
            : undefined,
      status,
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      startedAt: snapshot?.startedAt,
      completedAt: snapshot?.completedAt,
      outputPath: outputMetadata.outputFile,
      stderrPersistedOutputPath: outputMetadata.stderrFile,
      stdoutPersistedOutputPath: outputMetadata.stdoutFile,
      outputBytes: outputMetadata.outputBytes,
      outputTruncated: outputMetadata.outputTruncated,
      outputTail: outputMetadata.outputTail,
      stderrBytes: outputMetadata.stderrBytes,
      stderrTail: outputMetadata.stderrTail,
      stdoutBytes: outputMetadata.stdoutBytes,
      stdoutTail: outputMetadata.stdoutTail,
      terminalId: taskId,
    };
  }

  private backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
    return JSON.stringify({
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
      stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
      stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
      stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
    });
  }

  private canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).cancellable === true;
  }

  private isNotifiedLocalAgentSnapshot(
    toolCall: ExecutableToolCall,
    snapshot: BackgroundTaskSnapshot,
  ): boolean {
    const record = snapshot as unknown as Record<string, unknown>;
    return (
      isSubagentDispatchToolName(toolCall.name) &&
      record.type === "local_agent" &&
      record.notified === true
    );
  }

  private maybeEnqueueBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    traceContext: TraceContext,
    output?: Record<string, unknown>,
  ): void {
    if (!this.deps.enqueueBackgroundTaskNotification) {
      this.deps.logger?.debug?.("Background task notification queue unavailable", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.queue_unavailable",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    // Do not send a terminal notification for a run superseded by an amendment. The AmendWorkflow
    // tool result that stopped it is all the model needs to know about this stop; another
    // message like "you stopped run A, now amend it" would send the model into a loop. Still
    // claim it so a later TaskOutput read does not treat it as an undelivered notification.
    if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
      claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.info?.("Background task notification suppressed: run superseded", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        reason: "workflow_run_superseded",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    if (
      this.deps.shouldEnqueueBackgroundTaskNotification?.({
        runtimeScope: this.deps.runtimeScope,
        status,
        taskId,
        toolName: toolCall.name,
        traceContext,
      }) === false
    ) {
      this.deps.logger?.info?.("Background task notification suppressed by runtime policy", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    const text = this.formatBackgroundTaskNotification(toolCall, taskId, status, snapshot, output);
    if (!text) {
      this.deps.logger?.debug?.("Background task notification skipped without formatted message", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.skipped",
        module: "core.tool.executor",
        reason: "empty_message",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    // A TaskOutput terminal-state read first marks the same registry task as notified. Enqueue
    // completion only after a successful claim to prevent the model from receiving both the tool
    // result and a duplicate notification.
    if (!claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId)) {
      this.deps.logger?.debug?.("Background task notification already claimed", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.notification_already_handled",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    try {
      this.deps.enqueueBackgroundTaskNotification({
        ...(toolCall.name === "Bash"
          ? {
              originMeta: {
                backgroundSource: "bash" as const,
                title: resolveBashBackgroundResultTitle(toolCall, taskId),
                workId: taskId,
              },
            }
          : {}),
        // A workflow run's terminal turn must render as a background-result header instead of a
        // bare model-only message, so originMeta is required (workId ≡ runId). CreateWorkflow
        // and ResumeWorkflowRun share the same shape (see isDynamicWorkflowRunDispatchToolName
        // for dispatch). The manifest payload (workflowNotification) is created here on the
        // emission side; it is the GUI's only rendering source and travels through the pipeline
        // with originMeta.
        ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
          ? {
              originMeta: buildWorkflowNotificationOriginMeta(toolCall, taskId, status, snapshot, output),
            }
          : {}),
        taskId,
        text,
        toolName: toolCall.name,
        traceContext,
      });
    } catch (error) {
      releaseRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.warn("Background task notification enqueue failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
      return;
    }
    this.deps.logger?.info?.("Background task notification enqueued", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.enqueued",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
  }

  private formatBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    output?: Record<string, unknown>,
  ): string | undefined {
    // Workflow runs reuse the legacy Workflow notification format
    // (formatWorkflowTaskNotification). Keep legacy "Workflow" as a separate case: it has no
    // dwf artifact/report semantics and uses its own output.response fallback branch in the
    // shared formatter.
    if (toolCall.name === "Workflow" || isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
      return this.formatWorkflowTaskNotification(toolCall, taskId, status, snapshot, output);
    }
    if (toolCall.name !== "Bash") return undefined;

    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const command = typeof input.command === "string" ? input.command : undefined;
    const description = typeof input.description === "string" ? input.description : undefined;
    const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
    const notificationStatus = normalizeBashTaskNotificationStatus(status);
    const summary = buildBackgroundTaskSummary({
      command,
      description,
      exitCode: result?.exitCode,
      lost: status === "lost",
      status: notificationStatus,
    });
    return formatTaskNotification({
      description,
      outputFile: outputMetadata.outputFile,
      status: notificationStatus,
      summary,
      taskId,
      taskType: "local_bash",
      toolUseId: toolCall.id,
    });
  }

  private formatWorkflowTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    launchOutput?: Record<string, unknown>,
  ): string {
    const output =
      snapshot && "output" in snapshot && isRecord(snapshot.output)
        ? snapshot.output
        : launchOutput;
    const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
    const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
    // Read the three dwf terminal states and stop reason from the snapshot: the run service
    // projects journal `stopReason` into `snapshot.stopReason`, so "who stopped it" no longer
    // lives only in the registry. registry.stopInitiator is only a compatibility fallback for
    // old ports/stubs that do not provide stopReason.
    const terminal = workflowSnapshotTerminal(status, snapshot);
    const stopReason =
      terminal?.stopReason ??
      (status === "cancelled"
        ? this.deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator
        : undefined);
    const summary = buildWorkflowTaskSummary({
      lost: status === "lost",
      status: notificationStatus,
      runStatus: terminal?.runStatus,
      stopReason,
      subject,
    });
    // dwf and legacy `Workflow` diverge on **result**:
    //   - A dwf artifact is any top-level script return value; use `snapshot.output` as-is and
    //     serialize it uniformly. **Never** fall back to launch output: its `response` is stale
    //     prose saying "the run started in the background," and that is worse than no result
    //     (the second manifestation of a desktop bug observed in testing).
    //   - legacy `Workflow` has a real `output.response`; falling back to launchOutput is part
    //     of its contract and is preserved byte for byte.
    // subject still uses the record-gated output above (display name does not affect artifact shape).
    // Extend dwf dispatch to ResumeWorkflowRun so resumed and newly started runs have the same
    // notification shape.
    const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
      ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
      : stringField(output, "response");
    // Progressive artifacts (`report(item)`) belong only to dwf; legacy `Workflow` has no such
    // concept and its notification remains unchanged byte for byte.
    // **Include them for all three terminal states** (completed / failed / cancelled): a run
    // that dies on ask 12 still completed 11 asks' worth of work. Reporting only "failed" would
    // discard all of that, which is exactly why reports exist. Entries come from kind="report"
    // journal rows (attached to the snapshot by the run service), not a memory-only projection.
    const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
    const reports = isDynamicWorkflow
      ? buildWorkflowReportsNotificationSection(
          workflowSnapshotReports(snapshot),
          workflowSnapshotReportCount(snapshot),
        )
      : undefined;
    // User-facing artifacts also belong only to dwf (legacy `Workflow` has no such concept, and
    // its notification remains unchanged byte for byte). Include them for all three terminal
    // states: artifacts published before a run failed are still visible to the user; if the
    // notification omits them, the model may repeat the work.
    const artifacts = isDynamicWorkflow
      ? buildWorkflowArtifactsNotificationSection(
          workflowSnapshotArtifacts(snapshot),
          WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
        )
      : undefined;
    // Script files also belong only to dwf: presentation guidance uses them to say "edit that
    // file in place" as the next step. The journal stores an absolute path, while the model sees
    // a workspace-relative path; it should Edit the file using the same path style it uses for
    // other file reads and writes.
    const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
    return formatTaskNotification({
      description: subject,
      // Artifact presentation guidance also belongs only to dwf.
      ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
      ...(scriptPath === undefined
        ? {}
        : { scriptPath: describeWorkflowScriptPath(scriptPath, this.deps.getWorkingDirectory()) }),
      error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
      ...(reports === undefined ? {} : { reports }),
      ...(artifacts === undefined ? {} : { artifacts }),
      result,
      status: notificationStatus,
      ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
      summary,
      taskId,
      taskType: "local_workflow",
      toolUseId: toolCall.id,
    });
  }

  private hasBackgroundTaskSnapshotProvider(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).getSnapshot !== undefined;
  }

  private hasDirectBackgroundTaskWaiter(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).waitForTerminal !== undefined;
  }

  private async waitForBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).waitForTerminal?.(taskId);
  }

  private async getBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).getSnapshot?.(taskId);
  }

  /**
   * Resolve the background lifecycle provider by tool name. Each branch describes which port
   * handles the tool's four lifecycle responsibilities, corresponding to the five pre-
   * generalization checks while preserving their semantics exactly.
   */
  private lifecycleProvider(toolCall: ExecutableToolCall): BackgroundTaskLifecycleProvider {
    const deps = this.deps;

    if (isSubagentDispatchToolName(toolCall.name)) {
      const getTask = deps.subagentPort?.getTask;
      return {
        ...(getTask ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) } : {}),
        // Reason for the fix: background Agents are stopped through subagentPort.stopTask;
        // the started payload cannot reuse Bash's executionPort capability check.
        cancellable: Boolean(deps.subagentPort?.stopTask),
      };
    }

    if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
      // Workflow run: snapshot/wait/cancel all come from the narrow DynamicWorkflowRunPort
      // (runId ≡ taskId ≡ workId). Determine cancellation support by whether the cancel method
      // exists, not by hard-coding it; port presence enables cancellation. This is required for
      // the detail-page Cancel button and background-panel stop action to share one path.
      // CreateWorkflow (new start) and ResumeWorkflowRun (resume) share one provider. When a
      // registry entry is re-armed, existing-merge semantics preserve the original tool row's
      // parentToolCallId, making both entry points identical to the tracker.
      const port = deps.dynamicWorkflowRunPort;
      if (port === undefined) return {};
      return {
        getSnapshot: (taskId: string) => port.getTask(taskId),
        ...(typeof port.waitForTask === "function"
          ? { waitForTerminal: (taskId: string) => port.waitForTask(taskId) }
          : {}),
        cancellable: typeof port.cancel === "function",
      };
    }

    if (toolCall.name === "Workflow") {
      // Legacy Workflow: snapshot and wait only, no cancellation; its stop entry point was never
      // wired (preserve the previous false value).
      const getTask = deps.workflowPort?.getTask;
      const waiter = getWorkflowTaskWaiter(deps.workflowPort);
      return {
        ...(getTask ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) } : {}),
        ...(waiter ? { waitForTerminal: (taskId: string) => waiter.waitForTask(taskId) } : {}),
        cancellable: false,
      };
    }

    if (toolCall.name === "Bash") {
      const waiter = getBackgroundTaskWaiter(deps.executionPort);
      const getBackgroundTask = deps.executionPort?.getBackgroundTask;
      return {
        ...(getBackgroundTask
          ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
          : {}),
        ...(waiter
          ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
          : {}),
        cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
      };
    }

    // Other tools keep the generic background surface from executionPort (no direct waiter), as before generalization.
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }
}

function isBackgroundTaskLaunch(
  toolCall: ExecutableToolCall,
  output: Record<string, unknown>,
): boolean {
  if (output.status === "backgrounded") return true;
  return isSubagentDispatchToolName(toolCall.name) && output.status === "async_launched";
}

type BashTaskNotificationStatus = "completed" | "failed" | "killed";

function normalizeBashTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  return normalizeBackgroundTaskNotificationStatus(status);
}

function normalizeBackgroundTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}

function resolveBashBackgroundResultTitle(
  toolCall: ExecutableToolCall,
  taskId: string,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Keep the provider-visible summary concise; task-notification's output-file field carries the full output path.
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}

function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: BashTaskNotificationStatus;
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // The summary must say how the task ended in one sentence; the model reads it before the XML
  // fields. Prefer the three dwf terminal states; legacy `Workflow` has no runStatus and falls
  // back to the tracker's generic wording.
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

type WorkflowTerminalRunStatus = "completed" | "errored" | "stopped";

/**
 * Three terminal-state facts from a dwf snapshot. Only the dwf snapshot branch has
 * `runStatus` / `stopReason` / `failure` (port contract `DynamicWorkflowRunSnapshot`). If an old
 * port or stub omits them, map using the tracker's generic wording: `failed` → errored,
 * `cancelled` → stopped (reason absent, so the caller falls back to the registry). Nonterminal
 * states return undefined.
 */
function workflowSnapshotTerminal(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
):
  | {
      runStatus: WorkflowTerminalRunStatus;
      stopReason?: DynamicWorkflowRunStopReason;
      failure?: DynamicWorkflowRunError;
    }
  | undefined {
  const record = snapshot === undefined ? undefined : (snapshot as Record<string, unknown>);
  const declared = record?.runStatus;
  const runStatus: WorkflowTerminalRunStatus | undefined =
    declared === "completed" || declared === "errored" || declared === "stopped"
      ? declared
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "errored"
          : status === "cancelled"
            ? "stopped"
            : undefined;
  if (runStatus === undefined) return undefined;
  const reason = record?.stopReason;
  const stopReason =
    runStatus === "stopped" &&
    (reason === "user" ||
      reason === "model" ||
      reason === "provider" ||
      reason === "interrupted" ||
      reason === "superseded")
      ? reason
      : undefined;
  const failure = isRecord(record?.failure)
    ? (record?.failure as unknown as DynamicWorkflowRunError)
    : undefined;
  return {
    runStatus,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function workflowTaskSubject(
  toolCall: ExecutableToolCall,
  taskId: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  return (
    stringField(input, "description") ??
    (snapshot && "description" in snapshot ? runtimeString(snapshot.description) : undefined) ??
    (snapshot && "name" in snapshot ? runtimeString(snapshot.name) : undefined) ??
    stringField(output, "name") ??
    stringField(input, "name") ??
    stringField(input, "scriptPath") ??
    taskId
  );
}

function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Bounds for fields in the manifest payload (`WorkflowNotificationMeta`). Truncate at the
 * emission site: the payload travels through the protocol and snapshot with the turnHeader row,
 * and the shared `workflowNotificationMetaSchema` enforces the same `.max()` limits, rejecting
 * the entire row on persistence if exceeded. Truncation is therefore a **pre-construction**
 * requirement, not optional cleanup. */
const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;
const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;
const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

/**
 * workflow originMeta for a workflow run terminal notification (including manifest payload).
 * CreateWorkflow and ResumeWorkflowRun have the same shape and both are constructed here:
 * title and summary share a source (`workflowTaskSubject`), and the payload is included only
 * when the task is **terminal and a snapshot is present** (nonterminal / lost without a snapshot
 * means the field is absent and the GUI falls back to a bare title row).
 */
function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/**
 * Snapshot facts → manifest payload for the terminal-state branch.
 *
 * Construct only for the three terminal states (completed / failed / cancelled) when a snapshot
 * is present. `lost` (snapshot missing) and nonterminal states return `undefined`; an absent
 * payload lets the GUI fall back to the current title row instead of reporting an empty shell.
 * **Usage/tokens are unavailable at emission time** (only an in-memory projection is available),
 * so include only durationMs and let the GUI look up tokens by runId at render time.
 */
function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  // Artifact: any top-level return value from the script, serialized uniformly. Truncation is
  // explicit: when `resultTruncated` is present, the preview is partial; fetch the full value by
  // run ID / GetWorkflowRun. resultForm matches serializeWorkflowArtifact's branches: strings
  // are unchanged (prose), everything else uses JSON.stringify (json).
  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  // Include progressive artifacts for all three terminal states: a run that dies on ask 12
  // still completed 11 asks' worth of work.
  const reports = buildWorkflowReportsManifestSection(
    workflowSnapshotReports(snapshot),
    workflowSnapshotReportCount(snapshot),
  );
  if (reports !== undefined) meta.reports = reports;

  // Chips payload for user-facing artifacts. This is the **only** data source for notification
  // row chips: cold hydration reads it back unchanged through the shared Zod schema, and a
  // missing key would make the chips disappear permanently. Include it for all three terminal
  // states, as with reports.
  const artifactsSection = buildWorkflowArtifactsManifestSection(workflowSnapshotArtifacts(snapshot));
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

/**
 * Map tracker terminal status to one of the three manifest terminal literals (`failed` → errored,
 * `cancelled` → stopped); return undefined for nonterminal states (running / lost, etc.) and omit
 * the payload. When the snapshot provides `runStatus`, it is authoritative (see
 * workflowSnapshotTerminal).
 */
function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * Wall-clock duration in the notification (the “Time” field on the completion card; see
 * docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
 *
 * Two sources; take the **larger** value:
 *   - This run: `completedAt - startedAt`, the interval observed by the process that settled it.
 *   - Active duration across the full lineage: `activeDurationMs`, summed by the port from the
 *     journal (each resumed run and every predecessor reached through `resumedFrom`); absent
 *     means unavailable.
 *
 * Defect (2026-09-21): reporting only the current generation can show a run that “ran for four hours and was amended once” as 12 seconds—each amendment
 * and resume restarts the in-process clock, and most of that generation may be cache replay. Use the greater value instead of always using lineage to preserve
 * “never underreport what this process observed”: if older events predate this process's accounting and the journal read port is absent, `activeDurationMs`
 * is missing and we fall back to the current generation; normally lineage is greater because it includes it.
 *
 * If neither source is available, omit the field (the card shows `—`) instead of writing 0.
 */
function workflowNotificationDurationMs(snapshot: BackgroundTaskSnapshot): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  const ownLifeMs =
    startedAt === undefined || completedAt === undefined
      ? undefined
      : nonNegativeFinite(completedAt - startedAt);
  const lineageMs =
    "activeDurationMs" in snapshot ? nonNegativeFinite(snapshot.activeDurationMs) : undefined;
  if (ownLifeMs === undefined) return lineageMs;
  return lineageMs === undefined ? ownLifeMs : Math.max(ownLifeMs, lineageMs);
}

/** Only finite nonnegative numbers count as durations; NaN / Infinity / negatives / non-numbers are treated as unavailable. */
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Progressive artifacts on a dwf snapshot. `BackgroundTaskSnapshot` is a union type (bash /
 * subagent / legacy workflow / dwf branches), and only the dwf branch has `reports`, so narrow
 * with `in` rather than an assertion. Still validate the shape defensively: this path receives
 * input from a port implementation, and the snapshot is a cross-package contract.
 */
/**
 * dwf script file on the snapshot (absolute path). Narrow it like
 * {@link workflowSnapshotReports} (`in`, not an assertion: `BackgroundTaskSnapshot` has four
 * branches and only dwf has this key), then validate with typeof. The snapshot is a cross-package
 * contract, and old ports/stubs may omit this field.
 */
function workflowSnapshotScriptPath(
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined || !("scriptPath" in snapshot)) return undefined;
  return typeof snapshot.scriptPath === "string" && snapshot.scriptPath.length > 0
    ? snapshot.scriptPath
    : undefined;
}

function workflowSnapshotReports(
  snapshot: BackgroundTaskSnapshot | undefined,
): readonly unknown[] | undefined {
  if (snapshot === undefined || !("reports" in snapshot)) return undefined;
  return Array.isArray(snapshot.reports) ? snapshot.reports : undefined;
}

/** Actual report count from the snapshot (`reports` contains only the first 256); absent means an older snapshot, so readers fall back to the item count. */
function workflowSnapshotReportCount(
  snapshot: BackgroundTaskSnapshot | undefined,
): number | undefined {
  if (snapshot === undefined || !("reportCount" in snapshot)) return undefined;
  return typeof snapshot.reportCount === "number" ? snapshot.reportCount : undefined;
}

/**
 * dwf **user-facing artifacts** on the snapshot (outputs published through `artifact.*`, not
 * the return value in `output`). Narrow it like {@link workflowSnapshotReports} (`in`, not an
 * assertion: `BackgroundTaskSnapshot` has four branches and only dwf has this key), then parse
 * the shape defensively; the snapshot is a cross-package contract.
 */
function workflowSnapshotArtifacts(
  snapshot: BackgroundTaskSnapshot | undefined,
): ReturnType<typeof toPublishedArtifactSummaries> {
  if (snapshot === undefined || !("artifacts" in snapshot)) return undefined;
  return toPublishedArtifactSummaries(snapshot.artifacts);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getBackgroundTaskWaiter(
  executionPort: ExecutionPort | undefined,
): BackgroundTaskWaiter | undefined {
  const candidate = executionPort as Partial<BackgroundTaskWaiter> | undefined;
  return typeof candidate?.waitForBackgroundTask === "function"
    ? (candidate as BackgroundTaskWaiter)
    : undefined;
}

function getWorkflowTaskWaiter(workflowPort: unknown): WorkflowTaskWaiter | undefined {
  const candidate = workflowPort as Partial<WorkflowTaskWaiter> | undefined;
  return typeof candidate?.waitForTask === "function"
    ? (candidate as WorkflowTaskWaiter)
    : undefined;
}

/**
 * Display category for a background task (panel grouping and icon). `taskKind` is cosmetic:
 * lifecycle semantics are already dispatched through the per-tool lifecycleProvider, so
 * changing this classification does not affect observation/wait/cancellation.
 *
 * Keep legacy `Workflow` (script workflow) classified as "bash": it cannot be cancelled and has
 * no detail page in the panel. It differs from workflow runs, and sharing a category would mix
 * them together in the panel.
 */
function backgroundTaskKind(toolName: string): "bash" | "subagent" | "workflow" {
  if (isSubagentDispatchToolName(toolName)) return "subagent";
  // Both dwf entry points (CreateWorkflow / ResumeWorkflowRun) use "workflow": they continue the
  // same run lifecycle, so panel grouping and icon should not depend on which entry point was used.
  return isDynamicWorkflowRunDispatchToolName(toolName) ? "workflow" : "bash";
}
