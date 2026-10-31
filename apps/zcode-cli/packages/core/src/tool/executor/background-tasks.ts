import {
  SessionEventType,
  traceContextToLogContext,
  type ExecutionPort,
  type SessionEvent,
  type TraceContext,
  type TurnId,
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
  buildWorkflowReportsNotificationSection,
  type BackgroundTaskSnapshot,
  buildWorkflowTaskSummary,
  workflowSnapshotTerminal,
  workflowTaskSubject,
  runtimeString,
  buildWorkflowNotificationOriginMeta,
  workflowSnapshotScriptPath,
  workflowSnapshotReports,
  workflowSnapshotReportCount,
  workflowSnapshotArtifacts,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
// Two artifacts: the one above is the script's **top-level return value** (the engine-internal
// `RunSettlement.artifact`, shown in `<result>`); the one below is output the script **publishes
// for the user** through `artifact.*` (shown in `<artifacts>`). Both appear side by side in the
// same completion notification, so keep them as separate fields.
import {
  buildWorkflowArtifactsNotificationSection,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";

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

    // The registry's terminal precedes event persistence; the owner must await the whole tracker, not just watch the state.
    const tracking = Promise.withResolvers<void>();
    this.deps.registerResidencyBlockingWork?.(tracking.promise);
    const track = (work: Promise<void>) => {
      this.deps.registerResidencyBlockingWork?.(work);
      return work;
    };
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
      tracking.resolve();
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
        void Promise.resolve(this.deps.executionPort?.cancelBackgroundTask?.(taskId)).catch(
          (error) => {
            this.deps.logger?.warn("Subagent background Bash cancellation failed", {
              ...traceContextToLogContext(traceContext),
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "background_task.subagent_bash.cancel_failed",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            });
          },
        );
      }, this.deps.subagentBackgroundBashMaxMs);
    }

    const emitRunningUpdate = async (snapshot: BackgroundTaskSnapshot) => {
      if (stopped) return;
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
          this.deps.logger?.debug?.(
            "Background task terminal notification already handled by subagent",
            {
              ...traceContextToLogContext(traceContext),
              event: "background_task.tracking.notification_already_handled",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            },
          );
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
        if (stopped || completing) return;
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
        void track(poll());
      }, 1_000);
      timer.unref?.();
      await track(poll());
    }

    if (hasDirectWaiter && !stopped) {
      void track(waitForCompletion());
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
              originMeta: buildWorkflowNotificationOriginMeta(
                toolCall,
                taskId,
                status,
                snapshot,
                output,
              ),
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
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
          : {}),
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
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) }
          : {}),
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

function resolveBashBackgroundResultTitle(toolCall: ExecutableToolCall, taskId: string): string {
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
