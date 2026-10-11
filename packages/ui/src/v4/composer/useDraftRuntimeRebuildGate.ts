import { useCallback, useEffect, useReducer, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** Maximum rebuild window. Measured agent start→ready is about 550–650ms, and createSession takes a few hundred ms more, so 5s leaves ample margin. Timeout only opens the gate; it does not cancel rebuilding—a late binding still updates effectiveSessionId and wakes attachment re-upload. */
export const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

export interface DraftRuntimeRebuildGateState {
  rebuilding: boolean;
  /** Prewarm session ID at the generation change; a different non-empty ID means rebuilding is complete. */
  pendingFrom: string | null;
  /** Monotonically increasing; used only to restart the timer effect when generation changes again during rebuilding. */
  epoch: number;
}

export type DraftRuntimeRebuildGateEvent =
  | { type: "runtimeRestart"; prewarmSessionId: string | null }
  | { type: "prewarmSessionChanged"; prewarmSessionId: string | null }
  | { type: "rebuildTimeout" };

export const DRAFT_RUNTIME_REBUILD_GATE_IDLE: DraftRuntimeRebuildGateState = {
  epoch: 0,
  pendingFrom: null,
  rebuilding: false,
};

export function reduceDraftRuntimeRebuildGate(
  state: DraftRuntimeRebuildGateState,
  event: DraftRuntimeRebuildGateEvent,
): DraftRuntimeRebuildGateState {
  switch (event.type) {
    case "runtimeRestart":
      return {
        epoch: state.epoch + 1,
        pendingFrom: event.prewarmSessionId,
        rebuilding: true,
      };
    case "prewarmSessionChanged":
      if (!state.rebuilding) return state;
      // Between retire and rebuild completion, binding is null; do not use that to open the gate.
      if (event.prewarmSessionId === null) return state;
      if (event.prewarmSessionId === state.pendingFrom) return state;
      return { epoch: state.epoch, pendingFrom: null, rebuilding: false };
    case "rebuildTimeout":
      if (!state.rebuilding) return state;
      return { ...state, rebuilding: false };
  }
}

export interface DraftRuntimeRebuildGate {
  /** The prewarm session is rebuilding; while true, sending must be disabled or attachments will be left on a session that no longer exists. */
  rebuilding: boolean;
}

/**
 * Events such as CUA Helper becoming ready or liveness recovery can retire the agent runtime (workspace-dispose), also clearing any prewarm session
 * in draft state that has not been persisted. On runtime generation change, this hook increments draftRuntimeInvalidationVersion
 * to trigger rebuilding and reports rebuilding=true during the window so the send gate can block sends.
 *
 * Prefer unavailable from onRuntimeLifecycle as the generation signal: it arrives at dispose time. onRuntimeRestart
 * arrives only after the replacement process starts and may never fire when the agent starts lazily.
 */
export function useDraftRuntimeRebuildGate(params: {
  /** Enabled only in draft state (sessionId === null). */
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Current prewarm session ID; a new non-empty value means rebuilding is complete. */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** Prefer this when the hosting transport exposes runtime liveness, instead of onRuntimeRestart. */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeLifecycle,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
    workspaceIdentity,
    workspacePath,
  } = params;
  const [state, dispatch] = useReducer(
    reduceDraftRuntimeRebuildGate,
    DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  );

  // Keep enabled / prewarmSessionId in refs: if handleRuntimeRestart depends on them, every session-ID change
  // cancels and resubscribes, and the transport disposes its upstream when listeners reach zero—in that gap,
  // a generation-change event may be lost.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const prewarmSessionIdRef = useRef(prewarmSessionId);
  prewarmSessionIdRef.current = prewarmSessionId;

  const handleRuntimeRestart = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ prewarmSessionId: prewarmSessionIdRef.current, type: "runtimeRestart" });
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    // Subscribe through one path only: subscribing to both channels would process the same generation change twice, creating an unnecessary prewarm session and uploading attachments twice.
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        // No need to handle available: rebuilding starts from unavailable; prewarmSessionChanged opens the gate.
        if (state === "unavailable") handleRuntimeRestart();
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(handleRuntimeRestart);
  }, [handleRuntimeRestart, onRuntimeLifecycle, onRuntimeRestart]);

  useEffect(() => {
    dispatch({ prewarmSessionId, type: "prewarmSessionChanged" });
  }, [prewarmSessionId]);

  // Depend on epoch instead of rebuilding: rebuilding remains true if another generation change occurs mid-rebuild,
  // and only an epoch change can restart the timer.
  useEffect(() => {
    if (!state.rebuilding) return;
    const timer = setTimeout(() => dispatch({ type: "rebuildTimeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [state.epoch, state.rebuilding, timeoutMs]);

  return { rebuilding: state.rebuilding };
}
