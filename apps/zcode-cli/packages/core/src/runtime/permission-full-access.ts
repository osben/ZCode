import { permissionGrantCommittedReasons } from "@zcode/shared/zcode-protocol-v4";
import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "./execution-state.js";
import { getPendingSessionPersistence } from "./methods/events.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Map<string, SessionEvent>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
export async function grantPermissionMode(
  this: AgentRuntimeInternal,
  interactionId: string,
  mode: "guarded" | "yolo",
  signal?: AbortSignal,
): Promise<string> {
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  this.permissionFullAccessPending = true;
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    const appliedEvent = appliedGrants.get(this)?.get(interactionId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else if (appliedEvent) {
      // A draft has no receipt; after a publish failure the original event must be reused so the grant is not repeated or later user choices are not overwritten.
      event = appliedEvent;
    } else {
      const projection = await this.rebuildProjection();
      // Sampling may create the parent record concurrently; wait for it after the last async preparation so child rows are not written or overwritten by stale permissions.
      const pendingPersistence = getPendingSessionPersistence(this);
      if (pendingPersistence) await pendingPersistence;
      signal?.throwIfAborted();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      const next = { ...previous, mode };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      signal?.throwIfAborted();
      // A draft has no session parent row yet; the first send saves it from the current in-memory config, so the grant must not register the task early.
      if (this.sessionPersisted)
        await this.sessionStore.commitPermissionFullAccess({
          sessionID: this.sessionId,
          queueItemIds,
          signal,
          execution: buildExecutionStateEntry(this.sessionId, next),
          receipt: {
            id: receiptId,
            sessionID: this.sessionId,
            type: PERMISSION_FULL_ACCESS_ENTRY,
            touchSession: false,
            time: { created: Date.now(), updated: Date.now() },
            data: { interactionId, event },
          },
        });
    }
    const payload = event.payload as SessionModeChangedPayload;
    // 重试只允许完成原授权，不能把另一模式的既有回执当作本次选择成功。
    if (payload.mode !== mode) {
      if (payload.mode !== "guarded" && payload.mode !== "yolo")
        throw new Error("Invalid committed permission mode");
      throw Object.assign(new Error("Permission grant mode mismatch"), {
        reasonCode: permissionGrantCommittedReasons[payload.mode],
      });
    }
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionMode.call(this, interactionId, mode),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // The grant is applied synchronously from here; even if transport is cancelled afterward, the projection publish must still complete so a half-applied grant is not produced.
    const applied = appliedGrants.get(this) ?? new Map<string, SessionEvent>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      this.config.mode = payload.mode;
      this.config.planEnabled = payload.planEnabled;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode };
      }
      applied.set(interactionId, event);
      appliedGrants.set(this, applied);
    }
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    this.permissionFullAccessPending = false;
  }
}
