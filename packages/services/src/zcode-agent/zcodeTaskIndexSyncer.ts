/* eslint-disable max-lines -- V4 frame ingestion, snapshot upserts, and workspace broadcasts for the task index must share one closure state. */
import { repairSubagentTaskIndex } from "#src/zcode-agent/repairSubagentTaskIndex.js";
import {
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getZCodeUserVisibleMessages,
  isZCodeGoalContinuationReminderText,
  isZCodeModelOnlySyntheticUserMessage,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskGoal,
  type ZCodeTaskMode,
  type ZCodeTaskMeta,
  type ZCodeMessagePart,
  type ZCodeSessionMode,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionPhase,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type V4SessionsIndexSubscribeResult,
  type V4WorkspaceConfigSubscribeResult,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeWorkspaceEventSubscriptionParams } from "#src/session/zcodeTaskListTypes.js";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import { formatTaskMetaModelSelectionFromSnapshot } from "./zcodeConfigOptions.js";

const logger = createServiceLogger("zcode-task-index-syncer");

/** Scope for the V4 subscription connectionId: a different generation from the renderer sidebar's shared topic (resubscription replaces it). */
const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
const MAX_PENDING_TOPIC_FRAMES = 1_024;
const MAX_PENDING_TOPIC_BYTES = 32 * 1024 * 1024;
const INITIAL_BASELINE_SEED_BATCH_SIZE = 64;
const PROVIDER_NOT_READY_RETRY_MS = 5_000;
const TOPIC_SUBSCRIBE_WARN_INTERVAL_MS = 60_000;

type TopicSubscribeReason =
  | "initial"
  | "runtime-restart"
  | "snapshot-recovery-gap"
  | "recovery-frame-timeout"
  | "resync-ack-mismatch"
  | "resync-failed"
  | "force-recovery-gap"
  | "pre-ack-overflow"
  | "provider-not-ready-wait"
  | "retry";
type TopicRetryKind = "provider-not-ready" | "transient";
type TaskIndexTopicKind = "sessions-index" | "workspace-config";

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;

interface WorkspaceBroadcastTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
}

export interface ZCodeTaskIndexTerminalEvent {
  target: ZCodeAgentSessionTarget;
  /** V4 terminal phase mapping: completedSuccess/completedInterrupted → turn.completed; error → turn.failed. */
  kind: "turn.completed" | "turn.failed";
}

export interface ZCodeTaskIndexReadyEvent {
  target: ZCodeAgentSessionTarget;
  /** V4 terminal phase mapping: ready boundary at which the agent can accept the next input. */
  reason: "prompt_completed" | "prompt_failed";
}

export interface ZCodeTaskIndexSyncer {
  /**
   * Idempotently create a background V4 ingestion subscription for a workspace (sessions-index + workspace-config),
   * persisting authoritative CLI projections of session terminal state/title/configuration catalog to task index SQLite and workspace broadcasts.
   * Repeated calls for the same workspace create only one subscription.
   */
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  /**
   * Compatibility entry point (legacy shadow-subscription API shape): session-scoped activation signals are consolidated into
   * a workspace-scoped V4 subscription. options.includeSnapshot has no equivalent meaning for V4 ingestion (the initial
   * sessions-index snapshot silently inserts missing rows and does not replay terminal events or broadcast); retain the parameter to preserve the call surface.
   */
  ensureSessionSubscription(
    target: ZCodeAgentSessionTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void;
  /**
   * Sync a session snapshot to SQLite and broadcast workspace_task_list_changed.
   * On the desktop-continuous path, zcodeSessionService calls this after createSession/resumeSession/setModel
   * (legacy send/steer/fork/compact/rewind write paths were removed; writes now go through
   * V4 commands and sessions-index/workspace events), giving SQLite the latest title/updatedAt and refreshing the UI list.
   */
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      /**
       * Design correction: required. Changes such as model selection (task_model_changed) and snapshot convergence (task_status_changed)
       * must not use task_meta_changed; the UI treats that reason as an ownership change
       * and reloads global membership and the full list.
       */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta>;
  /**
   * Update only the model record in the task index; do not broadcast a historical snapshot.
   * Resume before sending disables snapshot broadcasts so an old terminal state cannot overwrite the local streaming UI,
   * but SQLite still needs its model updated from a deleted historical model to the available model actually in use.
   */
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
  /**
   * Explicitly trigger a workspace_task_list_changed broadcast.
   * Used by the adapter: task metadata changes such as archive / rename / pin / delete still need to be broadcast.
   * Design correction: reason is required. The previous default (task_meta_changed) silently assigned every unspecified emission
   * the UI's heaviest refresh semantics (reload global membership), causing input actions/task completion to refresh the entire sidebar list.
   * Emitters must declare the change category explicitly.
   */
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    meta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  /**
   * Get the shared workspace emitter so the adapter can fire events other than task_list_changed
   * (for example workspace_config_options_update). The adapter and syncer then use the same emitter,
   * and subscribers need only subscribe once to receive all events.
   */
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  /** Subscribe to the workspace event stream. adapter.onDynamicWorkspaceEvent forwards directly here. */
  onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent>;
  /**
   * Subscribe to session phase transitions to terminal states observed through V4 sessions-index.
   * This is not a UI stream; it is used to settle internal service state such as the host runtime command queue.
   */
  onSessionTerminalEvent: Event<ZCodeTaskIndexTerminalEvent>;
  /**
   * Subscribe to the prompt-ready state after a session settles (phase enters completedSuccess/completedInterrupted/error).
   * The mobile host command queue may use only this event as the boundary for sending the next input.
   */
  onSessionReadyEvent: Event<ZCodeTaskIndexReadyEvent>;
  /** Current non-cancelled worktree preparations from the Host's live sessions-index projections. */
  listWorktreePreparations(): Array<{
    targetPath: string;
    branchName: string;
    workspacePath: string;
    status: "preparing" | "failed";
  }>;
  /** Observe existing subscriptions only: tasks whose sessions-index phase is not terminal (running in the live set). */
  activeTaskRefs(): Array<{ workspacePath: string; workspaceIdentity?: string; taskId: string }>;
  /** Release all V4 subscriptions and the workspace emitter; do not close the injected taskIndexRepo. */
  disposeAll(): void;
}

interface CreateZCodeTaskIndexSyncerOptions {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
}

/** Terminal phases used to detect transitions in the conflated latest state from sessions-index. */
function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

function resolveTerminalUnreadSignal(
  summary: Pick<SessionSummary, "phase" | "goalStatus">,
): ZCodeWorkspaceTaskListChanged["unreadSignal"] {
  if (summary.phase === "error") {
    return "background_terminal";
  }
  if (
    (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") &&
    (summary.goalStatus === undefined || summary.goalStatus === "verified")
  ) {
    return "background_terminal";
  }
  return undefined;
}

function taskStatusFromSummaryPhase(phase: SessionPhase): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function buildBaselineMetaFromSummary(
  target: ZCodeAgentWorkspaceTarget,
  summary: SessionSummary,
): ZCodeTaskMeta {
  const status = taskStatusFromSummaryPhase(summary.phase);
  return {
    taskId: summary.sessionId,
    traceId: generateTraceId(summary.sessionId),
    title: summary.title,
    ...(summary.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
    mode: "default",
    provider: ZCODE_AGENT_PROVIDER,
    ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

interface WorkspaceIngestState {
  target: ZCodeAgentWorkspaceTarget;
  /** Currently attached Agent runtime generation; null means dormant. */
  runtimeGeneration: number | null;
  /** sessions-index subscription generation (frame filter gate; null means subscription is being established). */
  indexSubscriptionId: string | null;
  /** workspace-config subscription generation. */
  configSubscriptionId: string | null;
  /** Each topic has its own generation; recovery of one topic must not invalidate a late ACK from its sibling. */
  indexSubscriptionGeneration: number;
  configSubscriptionGeneration: number;
  indexPending: PendingTopicFrames<SessionsIndexTopicWireCandidate> | null;
  configPending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate> | null;
  /** Independently track each topic's confirmed watermark; do not share one seq/epoch. */
  indexLogEpoch: string | null;
  indexSeq: number;
  configLogEpoch: string | null;
  configSeq: number;
  /** ACK proves admission only; use epoch/seq as the resume base only after the first logical frame is atomically applied. */
  indexHasAppliedBase: boolean;
  configHasAppliedBase: boolean;
  indexRecovery: TopicRecoveryState | null;
  configRecovery: TopicRecoveryState | null;
  indexRecoveryGeneration: number;
  configRecoveryGeneration: number;
  /** Topic-local backoff after a transient runtime restart/recovery RPC failure; the sibling topic remains active. */
  indexRetryTimer: ReturnType<typeof setTimeout> | null;
  configRetryTimer: ReturnType<typeof setTimeout> | null;
  indexRetryAttempt: number;
  configRetryAttempt: number;
  /** Rate-limit production warnings for persistent failures; clear after a successful subscription so a new failure is immediately visible. */
  indexLastWarnAt: number | null;
  configLastWarnAt: number | null;
  /** Session summary baseline used to diff terminal transitions and title changes. */
  summaries: Map<string, SessionSummary>;
  /** The first frame (snapshot) silently inserts missing rows without replaying historical terminal events or list broadcasts. */
  seeded: boolean;
  /** Keep the workspace-level frame emitter stable across runtime generations and install only one listener set. */
  frameListenersInstalled: boolean;
  disposables: IDisposable[];
  indexAssembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  configAssembler: TopicWireFrameAssembler<WorkspaceConfigTopicFrame>;
  assemblyTimer: ReturnType<typeof setTimeout> | null;
}

type TopicDeliveryKind = "initial" | "online" | "recovery";

interface TopicRecoveryState {
  generation: number;
  subscriptionId: string;
  forceSnapshot: boolean;
  ackReceived: boolean;
  frameApplied: boolean;
  upgradeToSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
}

interface PendingTopicFrames<TFrame> {
  generation: number;
  frames: TFrame[];
  stagedBytes: number;
  recoveryNeeded: boolean;
}

export function createZCodeTaskIndexSyncer(
  options: CreateZCodeTaskIndexSyncerOptions,
): ZCodeTaskIndexSyncer {
  const { agentService, taskIndexRepo } = options;
  // Move all task-index event ingestion from legacy protocol shadow subscriptions (session/subscribe +
  // session/event + state.updated) to V4 frames. The sessions-index topic provides the workspace-level conflated latest state for
  // status(phase)/title/lastActivity; workspace-config provides hot updates to the configuration catalog. Converge the body search index from a full snapshot
  // on terminal phase transitions (the V4 command path no longer has an op-driven snapshot-sync fallback).
  const workspaceIngests = new Map<string, WorkspaceIngestState>();
  // Previously workspaceEmitters were private to the adapter, leaving no broadcast path after the syncer wrote SQLite;
  // the UI never received workspace_task_list_changed. Move the emitter to the syncer and have the adapter forward to it,
  // so adapter and desktop-continuous paths share one subscription and events no longer split.
  const workspaceEmitters = new Map<string, Emitter<ZCodeWorkspaceEvent>>();
  const terminalEventEmitter = new Emitter<ZCodeTaskIndexTerminalEvent>();
  const readyEventEmitter = new Emitter<ZCodeTaskIndexReadyEvent>();
  let disposed = false;

  const indexTopicFor = (state: WorkspaceIngestState) =>
    sessionsIndexTopic(resolveWorkspaceKey(state.target));
  const configTopicFor = (state: WorkspaceIngestState) =>
    workspaceConfigTopic(resolveWorkspaceKey(state.target));
  const isProviderNotReadyError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
  const isRuntimeUnavailableError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  const logTopicSubscribeFailure = (
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void => {
    const message = `task index ${topic} 订阅失败 reason=${reason} workspace=${state.target.workspacePath}`;
    if (retryKind === "provider-not-ready") {
      // It is normal for a new user to have no model configured yet. Persistent warnings for both topics in every workspace
      // would create a log storm before the user takes any action. Debug logs are not persisted in production builds.
      logger.debug(undefined, message, error);
      return;
    }

    const lastWarnAt = topic === "sessions-index" ? state.indexLastWarnAt : state.configLastWarnAt;
    const now = Date.now();
    if (lastWarnAt === null || now - lastWarnAt >= TOPIC_SUBSCRIBE_WARN_INTERVAL_MS) {
      if (topic === "sessions-index") state.indexLastWarnAt = now;
      else state.configLastWarnAt = now;
      logger.warn(undefined, message, error);
      return;
    }
    // High-frequency retry details are for local troubleshooting only and must not be written to production logs at message-stream volume.
    logger.debug(undefined, message, error);
  };
  const createPendingFrames = <TFrame>(generation: number): PendingTopicFrames<TFrame> => ({
    generation,
    frames: [],
    stagedBytes: 0,
    recoveryNeeded: false,
  });
  const discardPendingFrames = <TFrame>(pending: PendingTopicFrames<TFrame> | null): void => {
    if (!pending) return;
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };
  const frameBytes = (
    frame: SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  ): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  const stagePendingFrame = <
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void => {
    if (pending.recoveryNeeded) return;
    const bytes = frameBytes(frame);
    if (
      bytes > MAX_PENDING_TOPIC_BYTES ||
      pending.frames.length + 1 > MAX_PENDING_TOPIC_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_TOPIC_BYTES
    ) {
      // An ACK-only initial notification may arrive before the Promise continuation. If the staging buffer overflows before subscription setup,
      // neither unbounded buffering nor silently dropping frames is acceptable. No provable base exists yet,
      // so mark recovery as required and start a new snapshot subscription for this topic only after its ACK arrives.
      discardPendingFrames(pending);
      pending.recoveryNeeded = true;
      logger.warn(
        undefined,
        `task index ${kind} ACK staging overflow; recovery-needed workspace=${resolveWorkspaceKey(state.target)}`,
      );
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const clearIndexPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.indexPending);
    state.indexPending = null;
    state.indexAssembler.clear();
  };
  const clearConfigPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.configPending);
    state.configPending = null;
    state.configAssembler.clear();
  };
  const clearPendingState = (state: WorkspaceIngestState): void => {
    clearIndexPendingState(state);
    clearConfigPendingState(state);
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    state.assemblyTimer = null;
  };
  const unsubscribeIndex = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeSessionsIndexV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index sessions-index 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const unsubscribeConfig = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index workspace-config 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const clearActiveSubscriptions = (state: WorkspaceIngestState): void => {
    const indexSubscriptionId = state.indexSubscriptionId;
    const configSubscriptionId = state.configSubscriptionId;
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
    if (indexSubscriptionId) void unsubscribeIndex(state, indexSubscriptionId);
    if (configSubscriptionId) void unsubscribeConfig(state, configSubscriptionId);
  };

  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    const key =
      typeof workspace === "string"
        ? workspace
        : resolveWorkspaceKey({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          });
    let emitter = workspaceEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeWorkspaceEvent>();
      workspaceEmitters.set(key, emitter);
    }
    return emitter;
  }

  function emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void {
    // Diagnostic log for sidebar refreshes after input actions: identify which operation broadcasts the task list and its reason.
    logger.debug(
      undefined,
      `[list-refresh-trace] emitWorkspaceTaskListChanged reason=${reason} taskId=${target.taskId ?? "-"} workspace=${target.workspacePath} hasMeta=${Boolean(taskMeta)}`,
    );
    getWorkspaceEmitter({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    }).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
      ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
    });
  }

  async function resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: {
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
    },
  ): Promise<void> {
    try {
      // The task index is a passive observer and may only read an existing runtime. Calling resumeSession
      // would materialize/resume the same session after Core has accepted the user's next prompt,
      // creating a second lifecycle writer. readSession(existing-only) retains full-snapshot indexing
      // without starting or modifying the runtime.
      // Performance root cause: every turn completion/title change/visibility change goes
      // through here, and a single full-history line can reach ~15MB, saturating host stdio
      // frame parsing and JSON.parse. The index reads only title/body/visibility/status, so
      // request contentProfile "index" (strips tool/reasoning/data URL payloads, keeps the
      // structure). messageLimit cannot be used: searchableText and the title fallback
      // depend on the start of the history.
      const snapshot = await agentService.readSession({
        ...target,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      });
      // Snapshot convergence syncs state/body and does not change pin/archive/unread ownership (task_status_changed).
      await syncSnapshotAndBroadcast(snapshot, {
        ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
        broadcastReason: "task_status_changed",
        moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
      });
    } catch (error) {
      logger.warn(
        undefined,
        `回源同步 task index 行失败 reason=${reason} taskId=${target.sessionId}`,
        error,
      );
    }
  }

  function sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget {
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId,
    };
  }

  function broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.sessionId,
    };
  }

  function emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    const phase = summary.phase;
    const failed = phase === "error";
    // Preserve legacy protocol order: first the terminal turn (settle the current input), then prompt ready (allow the next input).
    terminalEventEmitter.fire({
      target,
      kind: failed ? "turn.failed" : "turn.completed",
    });
    readyEventEmitter.fire({
      target,
      reason: failed ? "prompt_failed" : "prompt_completed",
    });
  }

  /** Terminal phase transition → converge SQLite status, broadcast, and index the body from a snapshot. */
  function applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    options?: { moveGroupedTaskToTop?: boolean },
  ): void {
    emitTerminalAndReady(target, summary);
    const failed = summary.phase === "error";
    const unreadSignal = resolveTerminalUnreadSignal(summary);
    logger.debug(undefined, "task 终态未读裁决", {
      goalStatus: summary.goalStatus ?? null,
      phase: summary.phase,
      taskId: target.sessionId,
      unreadSignal: unreadSignal ?? null,
    });
    // updatedAt comes from the CLI summary: Host receive time must not reorder history (I6).
    const updatedAt = summary.lastActivityAt;
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        // sessions-index summaries do not include lastError details for error states. Let the subsequent snapshot write the authoritative value
        // (a patch without the lastError key preserves the current value); completed retains the legacy behavior of clearing it.
        patch: failed
          ? { status: "error", updatedAt }
          : { status: "completed", lastError: undefined, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // Previously only SQLite was updated, with no broadcast; the UI listening for workspace_task_list_changed received no notice,
          // leaving the spinner visible and updatedAt ordering stale. Broadcast once to converge the list.
          // Terminal convergence changes status and must use task_status_changed.
          // The default task_meta_changed previously bumped the global membership version on every completed turn,
          // making every list reload ownership and causing a sidebar flash when a task ended.
          emitWorkspaceTaskListChanged(
            broadcastTargetFrom(target),
            meta,
            "task_status_changed",
            unreadSignal ? { unreadSignal } : undefined,
          );
        }
        // Read a full snapshot at terminal state: the V4 command path (createSession/sendText through v4/command)
        // does not use zcodeSessionService's op-driven snapshot sync, so missing rows/body search/lastError all converge here.
        // readSession(existing-only) reads only an existing runtime and does not restore the session again.
        void resyncTaskIndexRowFromAgent(target, failed ? "phase.error" : "phase.completed", {
          moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
          // If the patch has already been broadcast, the following snapshot must not generate another completion notice.
          // If the row is missing, pass the same signal to the snapshot result so the notice is neither lost nor duplicated.
          ...(meta || !unreadSignal ? {} : { unreadSignal }),
        });
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 phase 终态到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /**
   * Title change → patch the SQLite title only; fetch a full snapshot if the row is missing (matching legacy first_input semantics).
   * The patch deliberately carries no updatedAt: a rename or title echo is not session activity, so the row keeps its CLI order (I6).
   */
  function applyTitleChange(target: ZCodeAgentSessionTarget, title: string): void {
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { title },
      })
      .then((meta) => {
        if (meta) {
          // Title changes (first message/automatic title generation) are unrelated to ownership and occur for every task.
          // Use a dedicated reason to avoid reloading global membership whenever the initial or terminal title is persisted.
          emitWorkspaceTaskListChanged(broadcastTargetFrom(target), meta, "task_title_changed");
        } else {
          // Draft sessions do not pre-write placeholder rows. If the first title (legacy first_input) arrives before any
          // snapshot upsert, fetch a full snapshot rather than relying on an empty session placeholder.
          // V4 createSession does not pass through zcodeSessionService.createSession; when the first title arrives and no task-index row exists,
          // this is the new session's first persistence. The snapshot write must also set the minimum top-level grouped sort_order,
          // or the client will place this node at the end of the list.
          void resyncTaskIndexRowFromAgent(target, "meta.titleUpdated", {
            moveGroupedTaskToTop: true,
          });
        }
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 标题变更到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** Diff one summary against the baseline: skip drafts and converge terminal transitions/title changes separately. */
  function processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    _deliveryKind: TopicDeliveryKind,
  ): void {
    state.summaries.set(next.sessionId, next);
    // Drafts are in-memory only: do not persist them or add them to task-index SQLite.
    if (next.phase === "draft" && !next.worktreePreparation && !next.submissionPreparation) {
      return;
    }
    const target = sessionTargetFrom(state.target, next.sessionId);
    if (next.worktreePreparation || next.submissionPreparation) {
      if (!previous?.worktreePreparation && !previous?.submissionPreparation) {
        const meta = buildBaselineMetaFromSummary(state.target, next);
        void taskIndexRepo
          .seedTaskMetaIfMissing(meta)
          .then(() =>
            // Sidebar reads only list rows admitted with CLI facts (cli_created_at IS NOT NULL
            // in project storage); seeding alone leaves the reserved row invisible until an
            // unrelated admission happens to run. The first fact fills the display baseline.
            taskIndexRepo.applyCliFacts({
              meta,
              titleSource: next.titleSource,
            }),
          )
          .then((admitted) => {
            emitWorkspaceTaskListChanged(
              broadcastTargetFrom(target),
              admitted ?? meta,
              "task_meta_changed",
            );
          })
          .catch((error) =>
            logger.warn(undefined, "Could not index prepared worktree session", error),
          );
      }
      return;
    }
    const becameVisibleTask = previous === undefined || previous.phase === "draft";
    // A terminal transition means the baseline actually observed non-terminal → terminal. Do not replay terminal events for sessions with no baseline
    // (cold-recovery hydration or historical sessions first seen after gap fallback). Active sessions always enter the baseline as running/prewarming
    // first (the gateway fans out every event), so real completions are not missed.
    const becameTerminal =
      previous !== undefined && !isTerminalPhase(previous.phase) && isTerminalPhase(next.phase);
    if (becameTerminal) {
      applyTerminalTransition(target, next, {
        moveGroupedTaskToTop: becameVisibleTask,
      });
      return;
    }
    if (becameVisibleTask) {
      // A V4 prewarmed session promoted from draft, or a new session first seen in an online delta,
      // does not pass through zcodeSessionService.createSession. This is the earliest new-task boundary and does not depend on title timing;
      // fetch a snapshot immediately to write the task row and minimum grouped-root sort_order, preventing an unsequenced node from landing at the end.
      void resyncTaskIndexRowFromAgent(target, "session.became-visible", {
        moveGroupedTaskToTop: true,
      });
      return;
    }
    const title = next.title.trim();
    if (title && (previous === undefined || previous.title !== next.title)) {
      applyTitleChange(target, title);
    }
  }

  async function seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void> {
    const candidates = [...summaries].filter(
      (summary) =>
        summary.phase !== "draft" ||
        summary.worktreePreparation !== undefined ||
        summary.submissionPreparation !== undefined,
    );
    if (candidates.length === 0) return;
    // The pure V4 UI does not pass through zcodeSessionService.initializeWorkspace. If the first frame is silently treated as an existing SQLite baseline,
    // a new remote database remains empty forever. Perform only atomic insert-if-missing here: do not broadcast, replay historical terminal events, or overwrite existing product-shell state.
    // Later opens/settlement use a full snapshot to fill authoritative fields such as model and body-search data.
    // Disaster protection: there may be many historical sessions, so do not create one Promise per session and block the host event loop.
    // Write in fixed small batches and summarize failures in one production log rather than creating a log storm with per-session errors.
    let failedCount = 0;
    let firstError: unknown;
    for (let offset = 0; offset < candidates.length; offset += INITIAL_BASELINE_SEED_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INITIAL_BASELINE_SEED_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((summary) =>
          taskIndexRepo.seedTaskMetaIfMissing(buildBaselineMetaFromSummary(state.target, summary)),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedCount += 1;
          firstError ??= result.reason;
        }
      }
    }
    if (failedCount > 0) {
      logger.warn(
        undefined,
        `首次 sessions-index 基线补齐 task index 失败 workspace=${resolveWorkspaceKey(state.target)} failed=${failedCount} total=${candidates.length}`,
        firstError,
      );
    }
  }

  function deliveryKindOf(event: unknown): TopicDeliveryKind {
    const deliveryKind = (event as { deliveryKind?: unknown }).deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "recovery" ? deliveryKind : "online";
  }

  function faultDeliveryKindOf(event: unknown): TopicDeliveryKind | undefined {
    const deliveryKind = (event as { fault?: { deliveryKind?: unknown } }).fault?.deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "online" || deliveryKind === "recovery"
      ? deliveryKind
      : undefined;
  }

  function isLiveState(state: WorkspaceIngestState): boolean {
    return !disposed && workspaceIngests.get(resolveWorkspaceKey(state.target)) === state;
  }

  function clearRecoveryDeadline(recovery: TopicRecoveryState | null): void {
    if (!recovery?.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  function discardIndexRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.indexRecovery);
    state.indexRecovery = null;
  }

  function discardConfigRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.configRecovery);
    state.configRecovery = null;
  }

  function settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.indexRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardIndexRecovery(state);
      if (recovery.forceSnapshot) void subscribeIndexTopic(state, "snapshot-recovery-gap", true);
      else requestIndexRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardIndexRecovery(state);
      if (followup) requestIndexRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.indexRecovery !== recovery || recovery.frameApplied) return;
      discardIndexRecovery(state);
      if (!recovery.forceSnapshot) requestIndexRecovery(state, true);
      else void subscribeIndexTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.configRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardConfigRecovery(state);
      if (recovery.forceSnapshot) void subscribeConfigTopic(state, "snapshot-recovery-gap", true);
      else requestConfigRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardConfigRecovery(state);
      if (followup) requestConfigRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.configRecovery !== recovery || recovery.frameApplied) return;
      discardConfigRecovery(state);
      if (!recovery.forceSnapshot) requestConfigRecovery(state, true);
      else void subscribeConfigTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function completeIndexRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.indexRecovery) return;
    state.indexRecovery.frameApplied = true;
    settleIndexRecovery(state, state.indexRecovery);
  }

  function completeConfigRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.configRecovery) return;
    state.configRecovery.frameApplied = true;
    settleConfigRecovery(state, state.configRecovery);
  }

  function requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.indexSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.indexRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleIndexRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.indexHasAppliedBase || state.indexLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.indexRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.indexRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.indexLogEpoch!, seq: state.indexSeq };
    void agentService
      .resyncSessionsIndexV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        if (
          state.indexSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardIndexRecovery(state);
          void subscribeIndexTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleIndexRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        discardIndexRecovery(state);
        logger.warn(
          undefined,
          `task index sessions-index resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeIndexTopic(state, "resync-failed", true);
      });
  }

  function requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.configSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.configRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleConfigRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.configHasAppliedBase || state.configLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.configRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.configRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.configLogEpoch!, seq: state.configSeq };
    void agentService
      .resyncWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        if (
          state.configSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardConfigRecovery(state);
          void subscribeConfigTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleConfigRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        discardConfigRecovery(state);
        logger.warn(
          undefined,
          `task index workspace-config resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeConfigTopic(state, "resync-failed", true);
      });
  }

  function handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.indexRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        // A gap in the forced snapshot means the current same-sub stream is still unverifiable.
        // Do not guess at reconstruction; subscribe to a new snapshot generation for this topic.
        discardIndexRecovery(state);
        void subscribeIndexTopic(state, "force-recovery-gap", true);
      } else {
        requestIndexRecovery(state, true);
      }
      return;
    }
    requestIndexRecovery(state);
  }

  function handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.configRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        discardConfigRecovery(state);
        void subscribeConfigTopic(state, "force-recovery-gap", true);
      } else {
        requestConfigRecovery(state, true);
      }
      return;
    }
    requestConfigRecovery(state);
  }

  function applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.indexRecovery && frame.payload.kind === "deltas") {
      if (state.indexRecovery.frameApplied && frame.toSeq > state.indexSeq) {
        state.indexRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (deliveryKind === "online" && state.indexHasAppliedBase && frame.toSeq <= state.indexSeq) {
        return;
      }
      state.indexLogEpoch = frame.payload.snapshot.logEpoch;
      state.indexSeq = frame.toSeq;
      state.indexHasAppliedBase = true;
      const nextSummaries = new Map<string, SessionSummary>();
      for (const summary of frame.payload.snapshot.sessions) {
        nextSummaries.set(summary.sessionId, summary);
      }
      if (!state.seeded) {
        // First frame = silent baseline: do not replay historical terminal events or broadcast the list; atomically insert only missing rows
        // so an empty SQLite database on remote/new installations is populated through the pure V4 path.
        state.summaries = nextSummaries;
        state.seeded = true;
        void seedMissingRowsFromInitialSnapshot(state, nextSummaries.values());
        const generation = state.indexSubscriptionGeneration;
        void repairSubagentTaskIndex({
          target: state.target,
          visibleSessionIds: new Set(nextSummaries.keys()),
          agentService,
          taskIndexRepo,
          isCurrent: () => isLiveState(state) && state.indexSubscriptionGeneration === generation,
          onRemoved: () =>
            emitWorkspaceTaskListChanged(state.target, undefined, "task_meta_changed"),
        }).catch((error) => {
          logger.warn(
            undefined,
            `子代理历史列表索引修复失败 workspace=${resolveWorkspaceKey(state.target)}`,
            error,
          );
        });
        completeIndexRecoveryFrame(state, deliveryKind);
        return;
      }
      // Gap-fallback snapshot: diff against the baseline, which is equivalent to replaying the missing deltas (conflated semantics).
      const previousSummaries = state.summaries;
      state.summaries = new Map();
      for (const summary of nextSummaries.values()) {
        processSummary(state, previousSummaries.get(summary.sessionId), summary, deliveryKind);
      }
      completeIndexRecoveryFrame(state, deliveryKind);
      return;
    }
    if (!state.indexHasAppliedBase) {
      // A fresh task-index subscription never carries a base. After the entire initial batch is lost, no delta can establish a cold baseline;
      // only an owned snapshot can prove the complete state.
      handleIndexGap(state, deliveryKind === "recovery" ? "recovery" : "online");
      return;
    }
    if (frame.toSeq <= state.indexSeq) {
      // Any fully validated recovery can confirm delivery if a newer authoritative snapshot/online update already superseded it;
      // ordinary duplicate frames are still silently dropped.
      if (deliveryKind === "recovery" && state.indexHasAppliedBase) {
        completeIndexRecoveryFrame(state, deliveryKind);
      }
      return;
    }
    if (frame.fromSeq !== state.indexSeq) {
      handleIndexGap(state, deliveryKind);
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        processSummary(
          state,
          state.summaries.get(delta.session.sessionId),
          delta.session,
          deliveryKind,
        );
        continue;
      }
      // session.removed: SQLite deletion is finalized through the task deletion operation (adapter deleteTask /
      // host-side cleanup for the V4 deleteSession command); maintain only the baseline here.
      state.summaries.delete(delta.sessionId);
    }
    state.indexSeq = frame.toSeq;
    state.indexHasAppliedBase = true;
    completeIndexRecoveryFrame(state, deliveryKind);
  }

  function applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.configRecovery && frame.payload.kind === "deltas") {
      if (state.configRecovery.frameApplied && frame.toSeq > state.configSeq) {
        state.configRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (
        deliveryKind === "online" &&
        state.configHasAppliedBase &&
        frame.toSeq <= state.configSeq
      ) {
        return;
      }
      state.configLogEpoch = frame.payload.snapshot.logEpoch;
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    } else {
      if (!state.configHasAppliedBase) {
        handleConfigGap(state, deliveryKind === "recovery" ? "recovery" : "online");
        return;
      }
      if (frame.toSeq <= state.configSeq) {
        if (deliveryKind === "recovery" && state.configHasAppliedBase) {
          completeConfigRecoveryFrame(state, deliveryKind);
        }
        return;
      }
      if (frame.fromSeq !== state.configSeq) {
        handleConfigGap(state, deliveryKind);
        return;
      }
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    }
    const config =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.config
        : frame.payload.deltas.at(-1)?.config;
    if (!config || config.configOptions.length === 0) {
      // Do not send an empty catalog (the subscription seed has no live sessions): useZCodeConfig would clear
      // the model catalog in the chat toolbar when it receives empty configOptions.
      completeConfigRecoveryFrame(state, deliveryKind);
      return;
    }
    // The V4 payload matches the ZCodeConfigOption shape (confirmed by shared golden tests), so pass it through without mapping.
    // No changes are needed in downstream workspace_config_options_update consumers such as useZCodeConfig.
    getWorkspaceEmitter({
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
    }).fire({
      type: "workspace_config_options_update",
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
      configOptions: config.configOptions,
    });
    completeConfigRecoveryFrame(state, deliveryKind);
  }

  function markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void {
    logger.warn(
      undefined,
      `task index ${kind} physical assembly failed reason=${reasonCode} workspace=${resolveWorkspaceKey(state.target)}`,
    );
    if (kind === "sessions-index") {
      if (deliveryKind === "online" && state.indexRecovery) {
        state.indexRecovery.postRecoveryGapPending ||= state.indexRecovery.frameApplied;
        return;
      }
      // Do not downgrade an owned fault with malformed deliveryKind to online and leave an existing flight stuck.
      // If recovery already advanced it as a recovery fault, keep that; otherwise start an ordinary same-sub resync.
      handleIndexGap(state, deliveryKind ?? (state.indexRecovery ? "recovery" : "online"));
    } else {
      if (deliveryKind === "online" && state.configRecovery) {
        state.configRecovery.postRecoveryGapPending ||= state.configRecovery.frameApplied;
        return;
      }
      handleConfigGap(state, deliveryKind ?? (state.configRecovery ? "recovery" : "online"));
    }
  }

  function scheduleAssemblyExpiry(state: WorkspaceIngestState): void {
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    const expiries = [state.indexAssembler.nextExpiryAt, state.configAssembler.nextExpiryAt].filter(
      (value): value is number => value !== null,
    );
    if (expiries.length === 0) {
      state.assemblyTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...expiries);
    const timer = setTimeout(
      () => {
        state.assemblyTimer = null;
        const now = Date.now();
        for (const event of state.indexAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "sessions-index",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        for (const event of state.configAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "workspace-config",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        scheduleAssemblyExpiry(state);
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    timer.unref?.();
    state.assemblyTimer = timer;
  }

  function handleSessionsIndexWire(
    state: WorkspaceIngestState,
    wire: SessionsIndexTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== indexTopicFor(state)) return;
    // Check ownership before assembly; a foreign subscription must not occupy decoded staging.
    if (state.indexSubscriptionId === null) {
      if (state.indexPending) {
        stagePendingFrame(state, "sessions-index", state.indexPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.indexSubscriptionId) return;
    const events = state.indexAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.indexAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "sessions-index",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applySessionsIndexFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  function handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== configTopicFor(state)) return;
    if (state.configSubscriptionId === null) {
      if (state.configPending) {
        stagePendingFrame(state, "workspace-config", state.configPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.configSubscriptionId) return;
    const events = state.configAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.configAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "workspace-config",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applyWorkspaceConfigFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  async function activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.indexSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      // A runtime generation change may reuse subscriptionId; a late ACK from the old generation must not
      // unsubscribe the route with the same id already claimed by the new generation.
      if (state.indexSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeIndex(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.indexPending === pending) state.indexPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeIndex(state, result.ack.subscriptionId);
      if (generation === state.indexSubscriptionGeneration && isLiveState(state)) {
        void subscribeIndexTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.indexSubscriptionId = result.ack.subscriptionId;
    state.indexLogEpoch = result.ack.logEpoch;
    state.indexSeq = 0;
    // The subscribe ACK's epoch/seq0 is admission metadata only; the initial physical frame may still be incomplete or fail validation.
    // A base exists only after a logical snapshot/delta is atomically applied.
    state.indexHasAppliedBase = false;
    discardIndexRecovery(state);
    state.indexRetryAttempt = 0;
    state.indexLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleSessionsIndexWire(state, frame);
      }
    }
  }

  async function activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.configSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      if (state.configSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeConfig(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.configPending === pending) state.configPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeConfig(state, result.ack.subscriptionId);
      if (generation === state.configSubscriptionGeneration && isLiveState(state)) {
        void subscribeConfigTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.configSubscriptionId = result.ack.subscriptionId;
    state.configLogEpoch = result.ack.logEpoch;
    state.configSeq = 0;
    state.configHasAppliedBase = false;
    discardConfigRecovery(state);
    state.configRetryAttempt = 0;
    state.configLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleWorkspaceConfigWire(state, frame);
      }
    }
  }

  function scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.indexRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.indexRetryAttempt, 5));
    state.indexRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.indexRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeIndexTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.indexRetryTimer = timer;
  }

  function scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.configRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.configRetryAttempt, 5));
    state.configRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.configRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeConfigTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.configRetryTimer = timer;
  }

  async function subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    state.indexRetryTimer = null;
    const generation = ++state.indexSubscriptionGeneration;
    const previousSubscriptionId = state.indexSubscriptionId;
    state.indexSubscriptionId = null;
    discardIndexRecovery(state);
    clearIndexPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeIndex(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.indexSubscriptionGeneration) return;
    }
    const indexPending = createPendingFrames<SessionsIndexTopicWireCandidate>(generation);
    state.indexPending = indexPending;
    try {
      const result = await agentService.subscribeSessionsIndexV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateIndexSubscribe(state, generation, indexPending, result);
    } catch (error) {
      if (isLiveState(state) && state.indexSubscriptionGeneration === generation) {
        clearIndexPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "sessions-index", reason, error, retryKind);
        scheduleIndexRetry(state, retryKind);
      }
    }
  }

  async function subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.configRetryTimer = null;
    const generation = ++state.configSubscriptionGeneration;
    const previousSubscriptionId = state.configSubscriptionId;
    state.configSubscriptionId = null;
    discardConfigRecovery(state);
    clearConfigPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeConfig(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.configSubscriptionGeneration) return;
    }
    const configPending = createPendingFrames<WorkspaceConfigTopicWireCandidate>(generation);
    state.configPending = configPending;
    try {
      const result = await agentService.subscribeWorkspaceConfigV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateConfigSubscribe(state, generation, configPending, result);
    } catch (error) {
      if (isLiveState(state) && state.configSubscriptionGeneration === generation) {
        clearConfigPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "workspace-config", reason, error, retryKind);
        scheduleConfigRetry(state, retryKind);
      }
    }
  }

  function ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void {
    if (!isLiveState(state) || state.frameListenersInstalled) return;
    const workspace = state.target;
    // Dormant state skips initial establishment but goes directly to resubscribe after runtime becomes available.
    // If the default listener already exists, it misses the initial frame fired after the response in the same read.
    // Install the listener synchronously before any subscribe and reuse it across runtime generations.
    state.disposables.push(
      agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        handleSessionsIndexWire(state, frame),
      ),
      agentService.onDynamicWorkspaceConfigFrame(workspace)((frame) =>
        handleWorkspaceConfigWire(state, frame),
      ),
    );
    state.frameListenersInstalled = true;
  }

  async function establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void> {
    // Install the frame listener before subscribing: one stdio read may resolve the response promise and then synchronously fire
    // the initial notification before the await continuation runs. The handler must therefore stage frames;
    // byte-level response order does not mean subscriptionId has already taken effect in JS state.
    ensureWorkspaceFrameListeners(state);
    await Promise.all([
      subscribeIndexTopic(state, "initial", false),
      subscribeConfigTopic(state, "initial", false),
    ]);
  }

  /**
   * (CLI reconnect/resubscribe): after an agent process generation change, all subscriptions in CLI memory are lost and no
   * gap frame arrives because subscriptions become silently inactive. The placeholder early return in ensureWorkspaceSubscription also does not resubscribe.
   * Resend subscribe by workspaceKey here. Frame listeners are attached to the persistent workspace emitter
   * (agentService reconnects automatically when wireClient changes generation), so only the subscriptionId gate needs refreshing.
   * The new snapshot converges against the seeded baseline through the existing gap-fallback snapshot diff path.
   */
  function resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void {
    if (disposed) return;
    const state = workspaceIngests.get(workspaceKey);
    if (!state) return;
    ensureWorkspaceFrameListeners(state);
    // Previously both topics shared a Promise.all generation, so a transient failure on one side
    // invalidated the new subscription that succeeded on the other. Now each uses fresh subscribe and backoff retry independently.
    void subscribeIndexTopic(state, "runtime-restart", false);
    void subscribeConfigTopic(state, "runtime-restart", false);
  }

  const availableRuntimeGenerationByWorkspaceKey = new Map<string, number>();
  const hasRuntimeLifecycle = Boolean(agentService.onAgentRuntimeLifecycle);

  function suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void {
    const state = workspaceIngests.get(workspaceKey);
    if (!state || state.runtimeGeneration !== generation) return;
    state.runtimeGeneration = null;
    state.indexSubscriptionGeneration += 1;
    state.configSubscriptionGeneration += 1;
    state.indexRecoveryGeneration += 1;
    state.configRecoveryGeneration += 1;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.indexRetryTimer = null;
    state.configRetryTimer = null;
    discardIndexRecovery(state);
    discardConfigRecovery(state);
    clearPendingState(state);
    // Calling unsubscribe/retry after runtime exit would re-enter getClient.
    // unavailable clears local ownership only; the CLI subscription was destroyed with the process, so do not send a cleanup RPC.
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
  }

  const runtimeLifecycleDisposable = agentService.onAgentRuntimeLifecycle?.((event) => {
    if (disposed) return;
    if (event.state === "unavailable") {
      if (
        availableRuntimeGenerationByWorkspaceKey.get(event.workspaceKey) ===
        event.runtimeIdentity.generation
      ) {
        availableRuntimeGenerationByWorkspaceKey.delete(event.workspaceKey);
      }
      suspendWorkspaceAfterRuntimeUnavailable(event.workspaceKey, event.runtimeIdentity.generation);
      return;
    }

    availableRuntimeGenerationByWorkspaceKey.set(
      event.workspaceKey,
      event.runtimeIdentity.generation,
    );
    const existing = workspaceIngests.get(event.workspaceKey);
    if (!existing) {
      ensureWorkspaceSubscription({
        workspacePath: event.workspacePath,
        workspaceIdentity: event.workspaceIdentity,
      });
      return;
    }
    if (existing.runtimeGeneration === event.runtimeIdentity.generation) return;
    existing.runtimeGeneration = event.runtimeIdentity.generation;
    resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey);
  });

  // Keep restart compatibility for legacy test fixtures/hosts without lifecycle; production uses only available/unavailable.
  const runtimeRestartedDisposable = hasRuntimeLifecycle
    ? undefined
    : agentService.onAgentRuntimeRestarted?.((event) =>
        resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey),
      );

  function ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void {
    if (disposed) {
      return;
    }
    if (!target.workspacePath) {
      return;
    }
    const key = resolveWorkspaceKey(target);
    if (workspaceIngests.has(key)) {
      return;
    }
    const state: WorkspaceIngestState = {
      target: {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
      runtimeGeneration: availableRuntimeGenerationByWorkspaceKey.get(key) ?? null,
      indexSubscriptionId: null,
      configSubscriptionId: null,
      indexSubscriptionGeneration: 0,
      configSubscriptionGeneration: 0,
      indexPending: null,
      configPending: null,
      indexLogEpoch: null,
      indexSeq: 0,
      configLogEpoch: null,
      configSeq: 0,
      indexHasAppliedBase: false,
      configHasAppliedBase: false,
      indexRecovery: null,
      configRecovery: null,
      indexRecoveryGeneration: 0,
      configRecoveryGeneration: 0,
      indexRetryTimer: null,
      configRetryTimer: null,
      indexRetryAttempt: 0,
      configRetryAttempt: 0,
      indexLastWarnAt: null,
      configLastWarnAt: null,
      summaries: new Map(),
      seeded: false,
      frameListenersInstalled: false,
      disposables: [],
      indexAssembler: new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      configAssembler: new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      assemblyTimer: null,
    };
    // Write the placeholder to Map first so concurrent calls do not create duplicate subscriptions during setup.
    workspaceIngests.set(key, state);
    // When lifecycle is available, keep a dormant placeholder for a workspace without runtime; passive observers
    // must not start the CLI. Legacy hosts without lifecycle retain the explicit ensure behavior for compatibility.
    if (!hasRuntimeLifecycle || state.runtimeGeneration !== null) {
      void establishWorkspaceSubscriptions(state);
    }
  }

  async function syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta> {
    const meta = buildMetaFromSnapshot(snapshot, options);
    // Explicit resume from a legacy child tab still syncs the snapshot; read-only details must not be rewritten as the main task.
    if (snapshot.session.sessionKind === "subagent_child") return meta;
    // Also index visible chat content from snapshot.messages so body searches in TaskSearchDialog can match it;
    // old SQLite rows are naturally backfilled the next time they reach this code.
    const searchableText = buildSearchableTextFromSnapshot(snapshot);
    // If desktop-continuous first commits the task row and then adds grouped sort_order,
    // sessions-index can expose the unsequenced task to Renderer between writes, making it jump to the bottom and back to the top.
    const { meta: persisted, initializedGroupedOrder } = options?.moveGroupedTaskToTop
      ? await taskIndexRepo.syncTaskMetaAtGroupedTop({ meta, searchableText })
      : {
          meta: await taskIndexRepo.syncTaskMeta({ meta, searchableText }),
          initializedGroupedOrder: false,
        };
    // When createSession returns, the snapshot has neither a title nor a user message, so its default title becomes the "New session" placeholder.
    // Do not broadcast a snapshot with no user-visible content: otherwise the sidebar briefly shows "New session" and changes to the actual prompt only after sendPrompt completes.
    // Still write the SQLite row so a later title update through applyAgentPatch can find it. That title broadcast becomes the user's first view of the session in the list,
    // with the prompt text already in place and no flicker.
    if (!hasUserVisibleContent(snapshot)) {
      if (initializedGroupedOrder) {
        // When a prewarmed session is promoted from draft, grouped ordering is persisted before the first title.
        // Even if there is no task metadata to broadcast yet, notify the renderer to reload structure;
        // otherwise sessions-index shows the task while structure lacks its order, and this process places it at the end.
        emitWorkspaceTaskListChanged(
          {
            workspacePath: persisted.workspacePath,
            workspaceIdentity: persisted.workspaceIdentity,
            taskId: persisted.taskId,
          },
          undefined,
          "task_created",
        );
      }
      return persisted;
    }
    emitWorkspaceTaskListChanged(
      {
        workspacePath: persisted.workspacePath,
        workspaceIdentity: persisted.workspaceIdentity,
        taskId: persisted.taskId,
      },
      persisted,
      // A sessions-index frame may become visible before the first grouped sort_order is persisted.
      // On first initialization, use task_created to invalidate the active grouped-structure cache;
      // duplicate snapshots add no new order and retain the caller's original status/title semantics.
      initializedGroupedOrder ? "task_created" : options.broadcastReason,
      options.unreadSignal ? { unreadSignal: options.unreadSignal } : undefined,
    );
    return persisted;
  }

  async function syncTaskModel(
    target: ZCodeAgentSessionTarget,
    model: string,
  ): Promise<ZCodeTaskMeta | null> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return null;
    }
    try {
      return await taskIndexRepo.updateTaskState({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { model: normalizedModel },
      });
    } catch (error) {
      logger.warn(undefined, `同步 task 模型到 task index 失败 taskId=${target.sessionId}`, error);
      return null;
    }
  }

  return {
    ensureWorkspaceSubscription,

    ensureSessionSubscription(
      target: ZCodeAgentSessionTarget,
      _options?: {
        includeSnapshot?: boolean;
      },
    ): void {
      if (!target.sessionId || !target.workspacePath) {
        return;
      }
      ensureWorkspaceSubscription({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    },

    syncSnapshotAndBroadcast,

    syncTaskModel,

    listWorktreePreparations() {
      const preparations: Array<{
        targetPath: string;
        branchName: string;
        workspacePath: string;
        status: "preparing" | "failed";
      }> = [];
      for (const state of workspaceIngests.values()) {
        for (const summary of state.summaries.values()) {
          const preparation = summary.worktreePreparation;
          if (preparation && preparation.status !== "cancelled") {
            preparations.push({
              targetPath: preparation.targetPath,
              branchName: preparation.branchName,
              workspacePath: state.target.workspacePath,
              status: preparation.status,
            });
          }
        }
      }
      return preparations;
    },

    emitWorkspaceTaskListChanged,

    getWorkspaceEmitter,

    onDynamicWorkspaceEvent(workspace: WorkspaceEventInput) {
      // Mounting the task list calls this entry point for every restored workspace. Listening for events does not mean
      // the user is using that workspace, so do not activate sessions-index or start the Agent here.
      return getWorkspaceEmitter(workspace).event;
    },

    onSessionTerminalEvent: terminalEventEmitter.event,

    onSessionReadyEvent: readyEventEmitter.event,

    activeTaskRefs() {
      return [...workspaceIngests.values()].flatMap((state) =>
        [...state.summaries.values()]
          .filter((summary) => !isTerminalPhase(summary.phase))
          .map((summary) => ({ ...state.target, taskId: summary.sessionId })),
      );
    },

    disposeAll(): void {
      disposed = true;
      for (const state of workspaceIngests.values()) {
        state.indexSubscriptionGeneration += 1;
        state.configSubscriptionGeneration += 1;
        state.indexRecoveryGeneration += 1;
        state.configRecoveryGeneration += 1;
        if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
        if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
        state.indexRetryTimer = null;
        state.configRetryTimer = null;
        discardIndexRecovery(state);
        discardConfigRecovery(state);
        clearPendingState(state);
        clearActiveSubscriptions(state);
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // Ignore dispose errors so all subscriptions are still given a chance to release.
          }
        }
      }
      workspaceIngests.clear();
      for (const emitter of workspaceEmitters.values()) {
        emitter.dispose();
      }
      workspaceEmitters.clear();
      terminalEventEmitter.dispose();
      readyEventEmitter.dispose();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartedDisposable?.dispose();
      availableRuntimeGenerationByWorkspaceKey.clear();
    },
  };
}

function buildMetaFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
  options?: {
    modelOverride?: string;
    thoughtLevelOverride?: string;
  },
): ZCodeTaskMeta {
  const modelOverride = options?.modelOverride?.trim();
  const thoughtLevelOverride = options?.thoughtLevelOverride?.trim();
  const meta: ZCodeTaskMeta = {
    taskId: snapshot.session.sessionId,
    traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    // When the user explicitly changes models or a historical model is unavailable, the session operation already carries a new available model.
    // Overwrite the task model in SQLite in these cases, or the next restore starts from the deleted historical model again.
    // Ordinary historical snapshots still prefer the model from the latest message, preventing a polluted settings.current from contaminating the index.
    model: modelOverride || formatTaskMetaModelSelectionFromSnapshot(snapshot),
    // When restoring a historical task, snapshot.settings.thoughtLevel may still contain the latest draft value for the workspace.
    // If the restore entry point provides a task-local thoughtLevel, persist that value to SQLite so the next open is not contaminated.
    thoughtLevel: thoughtLevelOverride || snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          // sessions-index terminal resync and the task service snapshot must share the same lastError attribution,
          // or error attribution will differ between the hot and cold read paths.
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot.projection, "target")) {
    // An absent target field means this snapshot did not provide goal information and must not overwrite the old index;
    // null means the database explicitly has no goal and the task-index target should be cleared.
    meta.target = snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target;
  }
  return meta;
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// When createSession returns, the snapshot has neither a real title nor a user message.
// Broadcasting this “blank session” would briefly show a “New session” placeholder in the sidebar.
// Check for user-visible content; if none exists, write only to SQLite and wait for the real title before broadcasting.
function hasUserVisibleContent(snapshot: ZCodeSessionStateSnapshot): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isZCodeGoalContinuationReminderText(title)) {
    return true;
  }
  if (snapshot.projection.target?.objective.trim()) {
    return true;
  }
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isZCodeModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// Global session search indexes only chat content visible by default, excluding reasoning, tool calls, and collapsed compaction sections.
// Assistant parts may contain both historical and latest content; take only the final text part here,
// matching the range shown in the UI's default collapsed view.
function buildSearchableTextFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  const parts: string[] = [];
  let total = 0;
  // Automatic /goal continuation persists an internal system-reminder as a runtime user turn.
  // This is model-only input, not a user-visible query, and must not be included in sidebar search text.
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // Key business rule: truncate at the limit so long tasks do not grow tasks-index.sqlite enough to affect startup or list queries.
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function fromZCodeGoal(
  goal: NonNullable<ZCodeSessionStateSnapshot["projection"]["target"]>,
): ZCodeTaskGoal {
  return {
    sessionID: goal.sessionId,
    targetID: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    time: {
      created: goal.createdAt,
      updated: goal.updatedAt,
    },
  };
}
