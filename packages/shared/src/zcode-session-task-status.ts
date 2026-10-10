// ── Legacy protocol compatibility surface (transitional) ──────────────────────────────
// One remaining export: deriveZCodeTaskStatusFromSessionSnapshot.
// Consumers: zcodeTaskServiceAdapter/zcodeTaskIndexSyncer/zcodeSessionProjection (legacy projection stack).
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import { getZCodeUserVisibleMessages } from "./zcode-session-visible-content.js";
import type { ZCodeTaskMeta } from "./zcode-task-types-core.js";
type ZCodeTaskStatus = ZCodeTaskMeta["status"];

function statusFromZCodeSession(
  status: ZCodeSessionStateSnapshot["session"]["status"],
): ZCodeTaskStatus {
  if (status === "running" || status === "waiting" || status === "paused") {
    return "running";
  }
  if (status === "error") return "error";
  if (status === "completed") return "completed";
  return undefined;
}

function hasBlockingActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  if (snapshot.runtime.activeTurnId || snapshot.runtime.activeTurnKind) {
    return true;
  }
  // projection.currentTurnId is the boundary of the last projected turn and remains after completion;
  // Only runtime-active fields, permissions, or tool calls prove that a real blocking runtime state still exists.
  if ((snapshot.projection.pendingPermissions ?? []).length > 0) {
    return true;
  }
  return (snapshot.projection.activeToolCalls ?? []).some(
    (toolCall) => toolCall.status === "pending" || toolCall.status === "running",
  );
}

function hasActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  return hasBlockingActiveSnapshotRuntime(snapshot);
}

function isToolCallContinuationFinish(finish: string | undefined): boolean {
  const normalized = finish?.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "tool-calls";
}

function hasCompletedVisibleAssistantTurn(snapshot: ZCodeSessionStateSnapshot): boolean {
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  const latestVisibleMessage = visibleMessages.at(-1);
  if (latestVisibleMessage?.info.role !== "assistant") {
    return false;
  }
  if (isToolCallContinuationFinish(latestVisibleMessage.info.finish)) {
    return false;
  }
  return typeof latestVisibleMessage.info.time.completed === "number";
}

export function deriveZCodeTaskStatusFromSessionSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskStatus {
  if (snapshot.projection.lastError) {
    return "error";
  }

  const status = statusFromZCodeSession(snapshot.session.status);
  if (status === "error" || status === "completed") {
    return status;
  }
  if (hasCompletedVisibleAssistantTurn(snapshot) && !hasBlockingActiveSnapshotRuntime(snapshot)) {
    // Desktop continuous session/read depends on the runtime projection.
    // A legacy projection may replay only through model_streaming finish and miss turn_complete, leaving currentTurnId
    // stale temporarily or indefinitely. In that case, the persisted assistant already has a completed timestamp, which is more authoritative than the stale currentTurnId.
    return "completed";
  }
  if (hasActiveSnapshotRuntime(snapshot)) {
    return status ?? "running";
  }
  return status;
}
