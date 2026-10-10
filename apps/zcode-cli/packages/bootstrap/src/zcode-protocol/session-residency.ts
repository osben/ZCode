// Adapter for session residency pool facts and deactivation operations.

import type { SessionId } from "@zcode/contracts";
import type {
  SessionDeactivationDecision,
  SessionResidentPoolHost,
} from "./session-resident-pool.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

interface SessionResidencyFinalizationOwner {
  residencyFinalizationCount?: number;
}

/**
 * The residency lease covers only the cleanup window for a Bootstrap detached runner, preventing
 * the pool from reclaiming a record that is still in use. Core now owns busy/idle authority for
 * prompt admission; activeAbortController is only a compatibility cancellation handle for the old
 * command path and must not be used as a prompt scheduling lock.
 */
function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

/** Register the lease synchronously, then start the detached runner; release it on synchronous throws and asynchronous termination. */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}

/**
 * Release only the resident runtime; do not delete any persistent session/task facts.
 *
 * If app.close is awaited before removing the registry entry, a new cold subscribe may hit the old
 * runtime while it is shutting down. If the record is removed first without setting the pool gate,
 * the old and new apps may concurrently access the same session resources. Therefore, synchronous
 * removal and asynchronous close must be combined into one lifecycle transaction by the pool's
 * in-flight gate.
 */
async function deactivateSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  // CommandInbox pin rejection used to occur after unsubscribe, leaving a partially cleared record
  // that remained in the registry but no longer received runtime events. All preflightable rejections
  // must happen before the first side effect.
  context.v4Gateway?.assertSessionRuntimeDeactivatable(sessionId);
  record.unsubscribe?.();
  context.v4Gateway?.deactivateSession(sessionId);
  context.sessions.delete(sessionId);
  await record.app.close?.();
  // After deactivation, the in-memory event store must be equivalent to one that was never loaded.
  await record.eventStore.deleteSession(sessionId as SessionId);
}

export function createSessionResidentPoolHost(
  context: ZCodeProtocolAgentServerContext,
): SessionResidentPoolHost {
  return {
    deactivate: (sessionId) => deactivateSessionRecord(context, sessionId),
    listSessionIds: () => [...context.sessions.keys()],
    readResidencyFacts: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        hasPendingInteractions: context.v4Interactions.hasPendingForSession(sessionId),
        hasQueuedCommands: context.v4Gateway?.hasResidencyBlockingCommands(sessionId) ?? false,
        hasLegacySubscriber: record.legacyStreamSubscribed === true,
        // active/queue and registry background tasks cannot cover detached work such as title, MCP,
        // and memory. The runtime maintains the unified query; protocol finalization only adds
        // protocol ownership.
        hasResidencyBlockingWork:
          record.activeAbortController !== undefined ||
          (record.residencyFinalizationCount ?? 0) > 0 ||
          record.app.runtime.hasResidencyBlockingWork(),
        hasSubscribers: context.v4Gateway?.hasConversationSubscribers(sessionId) ?? false,
        lastActivityAt: record.updatedAt,
        persisted: record.persistence === "immediate",
      };
    },
    onDeactivated: (sessionId, decision) => {
      context.logger?.info("Session resident runtime deactivated", {
        ...deactivationLogContext(decision),
        event: "zcode_protocol.session.resident_deactivated",
        sessionId,
      });
    },
    onError: (sessionId, error, decision) => {
      context.logger?.warn("Session resident deactivation failed", {
        ...deactivationLogContext(decision),
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.resident_deactivation_failed",
        sessionId,
      });
    },
  };
}

function deactivationLogContext(
  decision: SessionDeactivationDecision,
): Record<string, number | string> {
  return {
    highWaterCount: decision.highWaterCount,
    idleMs: decision.idleMs,
    idleTimeoutMs: decision.idleTimeoutMs,
    reason: decision.reason,
    residentCountBefore: decision.residentCountBefore,
    targetCount: decision.targetCount,
  };
}
