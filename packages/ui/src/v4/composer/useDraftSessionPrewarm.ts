/* oxlint-disable eslint(max-lines) -- Creation, reuse, cleanup, and first-frame ModelSelection for draft prewarming must share one owner state machine; splitting it across files would make StrictMode/transport-replacement cleanup timing harder to audit. */
// Prewarm the v4 draft session.
//
// Background: with no registered session in draft state, configuration has to use the legacy workspace-default RPC,
// whose buildWorkspaceState response constructs a full app each time (140–798 ms); the first send also has to
// createSession on demand. The v4 protocol already keeps phase=draft session entities ("binding a pane to a draft
// session means the server already has a session entity"). When the pane has no bound session, this module creates a
// draft session in the background as the prewarm carrier: configuration writes go directly to the session using v4 CAS,
// the first send reuses it, and an unused session is cleaned up. It stays in memory only and disappears when the CLI restarts;
// the gateway isDraftSession filter ensures it never leaks into the sessions-index sidebar as a "new task".
//
// Structure: lifecycle is owned by the pure controller startDraftSessionPrewarm (testable, with no React dependency);
// useDraftSessionPrewarm only wires effects and exposes owner-scoped bindings.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { CommandAck, CommandType, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
) => Promise<CommandAck>;

interface DraftPrewarmController {
  /** First admission command has been sent but its ACK is unresolved; dispose must not delete a session with an unknown result. */
  markPromotionPending(): void;
  /** Set after the first send succeeds; dispose must not delete the promoted session. */
  markPromoted(): void;
  /** Set after the session becomes invalid (subscription error/sendText rejected); dispose skips deleteSession because the session likely no longer exists. */
  markDiscarded(): void;
  /** Lifecycle end (effect cleanup / workspace switch / binding to a real session): deleteSession cleans up a created, unpromoted, valid session; if creation is still in flight, delete it locally when the ACK arrives. */
  dispose(): void;
}

/** Pure controller for prewarm lifecycle: create → surface through onReady → choose cleanup action on dispose. */
function startDraftSessionPrewarm(params: {
  workspaceKey: string;
  dispatchCommand: DispatchCommand;
  onReady: (sessionId: string) => void;
  /** Single-flight owner for waiting until the non-cancelable createSession call settles; invoke exactly once whether it succeeds or fails. */
  onSettled?: () => void;
  /** Initial config for the prewarmed session (synchronously resolved from the global "last selection"), so the first projected frame is global without a flash. */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftPrewarmController {
  const { workspaceKey, dispatchCommand, onReady, onSettled, resolveInitialConfig } = params;
  let disposed = false;
  let promotionState: "draft" | "pending" | "promoted" | "discarded" = "draft";
  let createdSessionId: string | null = null;

  const deleteCreatedSession = (sessionId: string) => {
    void dispatchCommand("deleteSession", {}, sessionId)
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[v4-draft-prewarm] 清理预热会话被拒", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
      })
      .catch(() => {
        // Cleanup failure is harmless: the in-memory session disappears when the CLI exits.
      });
  };

  const createPayload = () => {
    const createPayload: Record<string, unknown> = { workspaceId: workspaceKey };
    const initialConfig = resolveInitialConfig?.();
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      // The first frame of a prewarmed session already uses the global model (merged from createSession.config by the CLI), avoiding a flash of the workspace default.
      createPayload.config = initialConfig;
    }
    return createPayload;
  };
  const dispatchCreateSession = () => {
    const createSessionPayload = createPayload();
    if (disposed) {
      return Promise.resolve(null);
    }
    return dispatchCommand("createSession", createSessionPayload, null);
  };
  const createSessionAck = dispatchCreateSession();
  void createSessionAck
    .then((ack) => {
      if (!ack) {
        return;
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[v4-draft-prewarm] createSession 被拒，回落无预热路径", {
          status: ack.status,
          reasonCode: ack.reasonCode ?? null,
          workspaceKey,
        });
        return;
      }
      createdSessionId = ack.result.sessionId;
      if (disposed) {
        // Creation cannot be canceled when the user switches away quickly; delete it locally when the ACK arrives to avoid leaving an in-memory session behind.
        deleteCreatedSession(createdSessionId);
        return;
      }
      logger.info("[v4-draft-prewarm] draft session 预热就绪", {
        sessionId: createdSessionId,
        workspaceKey,
      });
      onReady(createdSessionId);
    })
    .catch((error) => {
      logger.warn("[v4-draft-prewarm] createSession 失败，回落无预热路径", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    })
    .finally(() => {
      onSettled?.();
    });

  return {
    markPromotionPending() {
      if (promotionState === "draft") {
        promotionState = "pending";
      }
    },
    markPromoted() {
      promotionState = "promoted";
    },
    markDiscarded() {
      if (promotionState !== "promoted") {
        promotionState = "discarded";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // During MCP initialization, the Agent may admit the first send before the renderer receives its ACK.
      // If owner cleanup treats it as an ordinary draft, it will close the execution adapter that is already running.
      // Only a draft that has never started promotion can be safely reclaimed automatically; pending must wait for the original command to settle.
      if (createdSessionId && promotionState === "draft") {
        deleteCreatedSession(createdSessionId);
      }
    },
  };
}

interface DraftSessionPrewarm {
  /** Prewarm binding ready for the current workspace/transport generation. */
  binding: DraftPrewarmBinding | null;
}

interface DraftPrewarmBinding {
  workspaceKey: string;
  sessionId: string;
  /** Synchronously claim the lifecycle before sending the first admission command; false means this binding is no longer the current owner. */
  beginPromotion(): boolean;
  /** Set after first-send success (prevents the cleanup path from calling deleteSession on a promoted session). */
  promote(): void;
  /** Discard after a subscription error/sendText rejection; affects only the controller that created this binding. */
  discard(): void;
}

interface DraftPrewarmSubscriber {
  invalidationVersion: number;
  onBinding: (binding: DraftPrewarmBinding | null) => void;
}

interface DraftPrewarmCurrent {
  invalidationVersion: number;
  controller: DraftPrewarmController;
  binding: DraftPrewarmBinding | null;
  settled: boolean;
  retiring: boolean;
  /** Retry attempt number for this generation; 0 means the initial attempt. */
  retryAttempt: number;
}

/** Backoff schedule after createSession failure. When the CUA Helper becomes ready, workspace-dispose reclaims the client and interrupts an in-flight createSession with client disposed. Warning once would permanently fall back to no-prewarm behavior, leaving draft state without a sessionId and pasted images stuck at waitingSession (0% progress). Reclamation is transient and retrying after a short delay can succeed, so use bounded backoff instead of giving up. */
const PREWARM_RETRY_DELAYS_MS = [500, 1000, 2000];

/** Prewarm coordinator for the same logical draft pane. createSession must not be tied directly to a React effect instance: cleanup cannot cancel a protocol request already sent, while the next effect would immediately send another createSession. The Agent's global FIFO could then fill with multiple slow creations for the same draft. Keep the owner across synchronous remounts and block the next generation from enqueueing another create until the previous create ACK arrives. */
class DraftSessionPrewarmCoordinator {
  private readonly subscribers = new Map<symbol, DraftPrewarmSubscriber>();
  private current: DraftPrewarmCurrent | null = null;
  private blockedInvalidationVersion: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchCommand: DispatchCommand;
  private resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;

  constructor(
    private readonly workspaceKey: string,
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
    private readonly onEmpty: () => void,
  ) {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  update(
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
  ): void {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  acquire(params: {
    invalidationVersion: number;
    onBinding: (binding: DraftPrewarmBinding | null) => void;
  }): () => void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const token = Symbol("draft-prewarm-subscriber");
    this.subscribers.set(token, params);
    this.reconcile();
    this.emitBindingTo(params);

    return () => {
      if (!this.subscribers.delete(token) || this.subscribers.size > 0) {
        return;
      }
      // React StrictMode and synchronous remounts with the same key run cleanup before the effect again. Defer confirmation until
      // the next task to avoid protocol churn from "create → cleanup delete → create" when the pane did not really leave.
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        if (this.subscribers.size > 0) {
          return;
        }
        this.retireCurrent();
        if (!this.current) {
          this.onEmpty();
        }
      }, 0);
    };
  }

  private requestedInvalidationVersion(): number | null {
    let latest: number | null = null;
    for (const subscriber of this.subscribers.values()) {
      latest =
        latest === null
          ? subscriber.invalidationVersion
          : Math.max(latest, subscriber.invalidationVersion);
    }
    return latest;
  }

  private reconcile(): void {
    const requestedVersion = this.requestedInvalidationVersion();
    if (requestedVersion === null) {
      return;
    }
    if (
      this.blockedInvalidationVersion !== null &&
      this.blockedInvalidationVersion !== requestedVersion
    ) {
      this.blockedInvalidationVersion = null;
    }
    if (this.current) {
      if (!this.current.retiring && this.current.invalidationVersion === requestedVersion) {
        return;
      }
      this.retireCurrent();
      // createSession cannot be canceled once sent; onSettled queues delete after its ACK, then starts only the newest generation.
      if (this.current) {
        return;
      }
    }
    if (this.blockedInvalidationVersion === requestedVersion) {
      return;
    }
    this.startCurrent(requestedVersion);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** createSession settled without a binding = failure (rejected or threw). client disposed due to reclamation is transient, so schedule another create with backoff; when retries are exhausted, retain the existing fallback to no prewarm path. */
  private scheduleRetryAfterFailure(failed: DraftPrewarmCurrent): void {
    const delay = PREWARM_RETRY_DELAYS_MS[failed.retryAttempt];
    if (delay === undefined) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current !== failed || failed.retiring || failed.binding !== null) return;
      if (this.subscribers.size === 0) return;
      const requestedVersion = this.requestedInvalidationVersion();
      if (requestedVersion === null || this.blockedInvalidationVersion === requestedVersion) return;
      // Release the failed generation so the next one can pass the reconcile single-flight gate.
      this.current = null;
      this.startCurrent(requestedVersion, failed.retryAttempt + 1);
    }, delay);
  }

  private startCurrent(invalidationVersion: number, retryAttempt = 0): void {
    let current!: DraftPrewarmCurrent;
    const controller = startDraftSessionPrewarm({
      workspaceKey: this.workspaceKey,
      dispatchCommand: (type, payload, targetSessionId) =>
        this.dispatchCommand(type, payload, targetSessionId),
      resolveInitialConfig: () => this.resolveInitialConfig?.(),
      onReady: (sessionId) => {
        if (this.current !== current || current.retiring) {
          return;
        }
        let binding!: DraftPrewarmBinding;
        binding = {
          workspaceKey: this.workspaceKey,
          sessionId,
          beginPromotion: () => {
            if (this.current !== current || current.binding !== binding) {
              return false;
            }
            current.controller.markPromotionPending();
            return true;
          },
          promote: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markPromoted();
          },
          discard: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markDiscarded();
            current.binding = null;
            this.blockedInvalidationVersion = current.invalidationVersion;
            this.emitBindings();
          },
        };
        current.binding = binding;
        this.emitBindings();
      },
      onSettled: () => {
        current.settled = true;
        if (this.current !== current || !current.retiring) {
          // Not retired but no binding received = createSession failed; transient reclamation can be retried with backoff.
          if (this.current === current && !current.retiring && current.binding === null) {
            this.scheduleRetryAfterFailure(current);
          }
          return;
        }
        this.current = null;
        if (this.subscribers.size > 0) {
          this.reconcile();
        } else {
          this.onEmpty();
        }
      },
    });
    current = {
      invalidationVersion,
      controller,
      binding: null,
      settled: false,
      retiring: false,
      retryAttempt,
    };
    this.current = current;
  }

  private retireCurrent(): void {
    const current = this.current;
    if (!current || current.retiring) {
      return;
    }
    this.clearRetryTimer();
    current.retiring = true;
    current.binding = null;
    current.controller.dispose();
    this.emitBindings();
    if (current.settled) {
      this.current = null;
    }
  }

  private emitBindings(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitBindingTo(subscriber);
    }
  }

  private emitBindingTo(subscriber: DraftPrewarmSubscriber): void {
    const current = this.current;
    subscriber.onBinding(
      current && !current.retiring && current.invalidationVersion === subscriber.invalidationVersion
        ? current.binding
        : null,
    );
  }
}

const draftPrewarmCoordinatorsByTransport = new Map<
  unknown,
  Map<string, DraftSessionPrewarmCoordinator>
>();

function logicalDraftOwnerKey(workspaceKey: string, paneId: string): string {
  return JSON.stringify([workspaceKey, paneId]);
}

function getDraftSessionPrewarmCoordinator(params: {
  workspaceKey: string;
  paneId: string;
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;
}): DraftSessionPrewarmCoordinator {
  let transportCoordinators = draftPrewarmCoordinatorsByTransport.get(params.transportIdentity);
  if (!transportCoordinators) {
    transportCoordinators = new Map();
    draftPrewarmCoordinatorsByTransport.set(params.transportIdentity, transportCoordinators);
  }
  const ownerKey = logicalDraftOwnerKey(params.workspaceKey, params.paneId);
  let coordinator = transportCoordinators.get(ownerKey);
  if (!coordinator) {
    coordinator = new DraftSessionPrewarmCoordinator(
      params.workspaceKey,
      params.dispatchCommand,
      params.resolveInitialConfig,
      () => {
        if (transportCoordinators?.get(ownerKey) !== coordinator) {
          return;
        }
        transportCoordinators.delete(ownerKey);
        if (transportCoordinators.size === 0) {
          draftPrewarmCoordinatorsByTransport.delete(params.transportIdentity);
        }
      },
    );
    transportCoordinators.set(ownerKey, coordinator);
  }
  return coordinator;
}

export function useDraftSessionPrewarm(params: {
  /** Enabled only while the pane has no bound session (sessionId===null). */
  enabled: boolean;
  workspaceKey: string;
  /** Logical pane identity within the same workspace; must remain stable across synchronous remounts. */
  paneId: string;
  /** Increment when external capabilities change; used only to reclaim and rebuild an unpromoted draft prewarm session. */
  invalidationVersion?: number;
  /** Transport identity for the conversation provider; remains stable while the workspace lease is unchanged. */
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  /** Initial config for the prewarmed session (synchronously resolved from the global "last selection"), so the first projected frame is global without a flash. */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftSessionPrewarm {
  const {
    enabled,
    workspaceKey,
    paneId,
    transportIdentity,
    invalidationVersion = 0,
    dispatchCommand,
    resolveInitialConfig,
  } = params;
  // Workspace/pane/transport together define the logical owner: remounts with the same owner reuse single-flight; a transport
  // replacement still creates a new coordinator so cleanup of the old session cannot accidentally use the new transport.
  const owner = useMemo(
    () => ({ workspaceKey, paneId, transportIdentity }),
    [paneId, transportIdentity, workspaceKey],
  );
  const coordinator = useMemo(
    () =>
      getDraftSessionPrewarmCoordinator({
        workspaceKey,
        paneId,
        transportIdentity,
        dispatchCommand,
        resolveInitialConfig,
      }),
    [owner],
  );
  useLayoutEffect(() => {
    coordinator.update(dispatchCommand, resolveInitialConfig);
  }, [coordinator, dispatchCommand, resolveInitialConfig]);
  const generation = useMemo(() => ({ owner }), [enabled, invalidationVersion, owner]);
  const [ready, setReady] = useState<{
    generation: typeof generation;
    binding: DraftPrewarmBinding;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return coordinator.acquire({
      invalidationVersion,
      onBinding: (binding) => {
        setReady((current) => {
          if (!binding) {
            return current?.generation === generation ? null : current;
          }
          return { generation, binding };
        });
      },
    });
  }, [coordinator, enabled, generation, invalidationVersion]);

  return { binding: ready?.generation === generation ? ready.binding : null };
}
