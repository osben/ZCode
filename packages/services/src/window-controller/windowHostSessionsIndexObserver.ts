import { createHash } from "node:crypto";
// Import the logger module directly: the @zcode/services/node barrel loads the voice-dictation native
// dependency (koffi), which the window-controller node bundle must not pull in (windowControllerExportBoundary test).
import { createServiceLogger } from "../logger/serviceLogger.js";
import { collectMobilePushEvents, type MobilePushEvent } from "@zcode/shared/web-remote-relay";
import type { IDisposable } from "@zcode/rpc";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
} from "../zcode-agent/zcodeAgent.js";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";

const notificationLogger = createServiceLogger("mobile-push");

const SUBSCRIBER_SCOPE = "window-controller";
const MAX_STAGED_WIRES = 1_024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;

type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;

export interface WindowHostSessionsIndexObserver {
  start(): Promise<void>;
  dispose(): void;
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Passive sessions-index observer for Window Host. It uses existing-only and remains
 * dormant when runtime is missing; bounded physical-wire buffering before ACK prevents losing an initial snapshot that arrives before the RPC response.
 */
export function createWindowHostSessionsIndexObserver(options: {
  agentService: SessionsIndexAgentService;
  target: { workspacePath: string; workspaceIdentity?: string };
  onSessionsChange: (sessions: SessionSummary[]) => void;
  onRunStarted?: (run: import("@zcode/shared/web-remote-relay").MobilePushRun) => void;
  onNotification?: (event: MobilePushEvent) => void;
  onError?: (error: unknown) => void;
}): WindowHostSessionsIndexObserver {
  const workspace = {
    workspacePath: options.target.workspacePath,
    ...(options.target.workspaceIdentity
      ? { workspaceIdentity: options.target.workspaceIdentity }
      : {}),
  };
  const workspaceKey = options.target.workspaceIdentity?.trim() || options.target.workspacePath;
  const topic = sessionsIndexTopic(workspaceKey);
  const summaries = new Map<string, SessionSummary>();
  const notificationRuns = new Map<string, string>();
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  let activeSubscriptionId: string | null = null;
  let cursor: { logEpoch: string; seq: number } | null = null;
  let disposed = false;
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  let restartAfterPending = false;
  let dormant = false;
  let recovering = false;
  let stagedWires: SessionsIndexTopicWireCandidate[] = [];
  let stagedBytes = 0;
  let stagingOverflowed = false;
  let assemblyTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = (): void => {
    options.onSessionsChange(Array.from(summaries.values()));
  };

  const clearAssemblyTimer = (): void => {
    if (assemblyTimer) clearTimeout(assemblyTimer);
    assemblyTimer = null;
  };

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const scheduleAssemblyExpiry = (): void => {
    clearAssemblyTimer();
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    assemblyTimer = setTimeout(
      () => {
        assemblyTimer = null;
        const faults = assembler.expire(Date.now()).filter((event) => event.kind === "fault");
        if (faults.length > 0) requestRecovery();
        scheduleAssemblyExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    assemblyTimer.unref?.();
  };

  const applyFrame = (frame: SessionsIndexTopicFrame, live: boolean): void => {
    if (frame.payload.kind === "snapshot") {
      summaries.clear();
      // recovery 快照只重建基线；仍在运行的任务沿用实时开始时建立的 owner，
      // 否则 gap 恢复后的终态会因 run_not_observed 被永久跳过。
      const running = new Set<string>();
      for (const session of frame.payload.snapshot.sessions) {
        summaries.set(session.sessionId, session);
        if (session.phase === "running" || session.phase === "prewarming")
          running.add(session.sessionId);
      }
      for (const sessionId of notificationRuns.keys())
        if (!running.has(sessionId)) notificationRuns.delete(sessionId);
      cursor = { logEpoch: frame.payload.snapshot.logEpoch, seq: frame.toSeq };
      recovering = false;
      clearRecoveryTimer();
      publish();
      return;
    }
    if (!cursor || frame.fromSeq !== cursor.seq) {
      requestRecovery();
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        if (live && !recovering) {
          const previous = summaries.get(delta.session.sessionId);
          const next = delta.session;
          const workspaceId = createHash("sha256").update(workspaceKey).digest("hex");
          if (
            (next.phase === "running" || next.phase === "prewarming") &&
            previous?.phase !== "running" &&
            previous?.phase !== "prewarming"
          ) {
            const runId = String(next.lastActivityAt);
            notificationRuns.set(next.sessionId, runId);
            options.onRunStarted?.({
              workspace_id: workspaceId,
              session_id: next.sessionId,
              run_id: runId,
            });
          }
          const runId = notificationRuns.get(next.sessionId);
          for (const event of collectMobilePushEvents(workspaceId, previous, next)) {
            const fields = {
              event_id: event.event_id,
              session_id: event.session_id,
              kind: event.kind,
              run_id: runId ?? null,
            };
            if (!runId) {
              notificationLogger.info(undefined, "event skipped", {
                ...fields,
                reason: "run_not_observed",
              });
              continue;
            }
            notificationLogger.info(undefined, "event generated", fields);
            options.onNotification?.({ ...event, run_id: runId });
          }
        }
        summaries.set(delta.session.sessionId, delta.session);
      } else {
        summaries.delete(delta.sessionId);
        notificationRuns.delete(delta.sessionId);
      }
    }
    cursor = { ...cursor, seq: frame.toSeq };
    publish();
  };

  const acceptOwnedWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (
      !activeSubscriptionId ||
      wire.topic !== topic ||
      wire.subscriptionId !== activeSubscriptionId
    ) {
      return;
    }
    const events = assembler.accept(wire);
    let faulted = false;
    for (const event of events) {
      if (event.kind === "fault") faulted = true;
      else applyFrame(event.frame, event.deliveryKind === "online");
    }
    if (faulted) requestRecovery();
    scheduleAssemblyExpiry();
  };

  const stageOrAcceptWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (disposed || wire.topic !== topic) return;
    if (activeSubscriptionId) {
      acceptOwnedWire(wire);
      return;
    }
    if (stagingOverflowed) return;
    const bytes = encodedBytes(wire);
    if (
      bytes > MAX_STAGED_BYTES ||
      stagedWires.length + 1 > MAX_STAGED_WIRES ||
      stagedBytes + bytes > MAX_STAGED_BYTES
    ) {
      // The initial frame may arrive before subscribe ACK; truncating its head would leave an incomplete
      // snapshot that still passes type validation. On overflow, discard the whole batch, cancel the subscription after ACK, and wait for the next runtime lifecycle.
      stagedWires = [];
      stagedBytes = 0;
      stagingOverflowed = true;
      return;
    }
    stagedWires.push(wire);
    stagedBytes += bytes;
  };

  function requestRecovery(): void {
    const subscriptionId = activeSubscriptionId;
    if (disposed || recovering || !subscriptionId) return;
    recovering = true;
    assembler.abort(topic, subscriptionId);
    void options.agentService
      .resyncSessionsIndexV4({
        ...workspace,
        subscriptionId,
        base: cursor,
        forceSnapshot: true,
        runtimePolicy: "existing-only",
      })
      .then(() => {
        if (disposed || activeSubscriptionId !== subscriptionId || !recovering) return;
        clearRecoveryTimer();
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (!disposed && activeSubscriptionId === subscriptionId && recovering) {
            resubscribeAfterRecovery();
          }
        }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
        recoveryTimer.unref?.();
      })
      .catch((error) => {
        recovering = false;
        if (!isRuntimeUnavailableError(error)) {
          options.onError?.(error);
          resubscribeAfterRecovery();
        }
      });
  }

  function resubscribeAfterRecovery(): void {
    const previousSubscriptionId = activeSubscriptionId;
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    if (previousSubscriptionId) {
      void options.agentService
        .unsubscribeSessionsIndexV4({
          ...workspace,
          subscriptionId: previousSubscriptionId,
          runtimePolicy: "existing-only",
        })
        .catch(() => {});
    }
    if (startPromise) restartAfterPending = true;
    else void start();
  }

  const frameSubscription =
    options.agentService.onDynamicSessionsIndexFrame(workspace)(stageOrAcceptWire);

  const invalidateRuntime = (): void => {
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    summaries.clear();
    publish();
  };

  let lifecycleSubscription: IDisposable | undefined;
  let restartSubscription: IDisposable | undefined;
  if (options.agentService.onAgentRuntimeLifecycle) {
    lifecycleSubscription = options.agentService.onAgentRuntimeLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      if (event.state === "unavailable") {
        dormant = true;
        invalidateRuntime();
        return;
      }
      const wasDormant = dormant;
      dormant = false;
      if (startPromise) {
        // The same existing-only subscribe may publish available before ACK; this does not indicate a runtime
        // generation change. Resubscribe after the current request settles only if a pending unavailable state was observed first.
        if (wasDormant) restartAfterPending = true;
      } else if (!activeSubscriptionId) void start();
    });
  } else {
    restartSubscription = options.agentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      invalidateRuntime();
      if (startPromise) restartAfterPending = true;
      else void start();
    });
  }

  async function start(): Promise<void> {
    if (disposed || dormant || activeSubscriptionId) return;
    if (startPromise) return startPromise;
    const subscribeGeneration = generation;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    // Record pending ownership in startPromise before subscribing. The Agent may synchronously publish runtime available before the RPC Promise
    // returns, and the lifecycle callback must not recursively enter start a second time.
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await options.agentService.subscribeSessionsIndexV4({
          ...workspace,
          visibility: "background",
          subscriberScope: SUBSCRIBER_SCOPE,
          runtimePolicy: "existing-only",
        });
        if (disposed || subscribeGeneration !== generation || stagingOverflowed) {
          void options.agentService
            .unsubscribeSessionsIndexV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
              runtimePolicy: "existing-only",
            })
            .catch(() => {});
          if (stagingOverflowed) {
            options.onError?.(new Error("fault.subscription.initialFrameStagingOverflow"));
          }
          return;
        }
        activeSubscriptionId = result.ack.subscriptionId;
        const initialWires = stagedWires;
        stagedWires = [];
        stagedBytes = 0;
        for (const wire of initialWires) acceptOwnedWire(wire);
      } catch (error) {
        if (!disposed && isRuntimeUnavailableError(error)) {
          // A new Host with lifecycle support waits for available before subscribing, avoiding a dormant RPC on every list query.
          dormant = Boolean(options.agentService.onAgentRuntimeLifecycle);
        } else if (!disposed) {
          options.onError?.(error);
        }
      }
    });
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = null;
      if (restartAfterPending && !disposed && !activeSubscriptionId) {
        restartAfterPending = false;
        void start();
      }
    }
  }

  return {
    start,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const subscriptionId = activeSubscriptionId;
      activeSubscriptionId = null;
      frameSubscription.dispose();
      lifecycleSubscription?.dispose();
      restartSubscription?.dispose();
      clearAssemblyTimer();
      clearRecoveryTimer();
      assembler.clear();
      stagedWires = [];
      if (subscriptionId) {
        void options.agentService
          .unsubscribeSessionsIndexV4({
            ...workspace,
            subscriptionId,
            runtimePolicy: "existing-only",
          })
          .catch(() => {});
      }
    },
  };
}
