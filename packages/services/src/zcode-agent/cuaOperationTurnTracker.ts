import { resolveWorkspaceKey, type ZCodeComputerUseOperationEvent } from "@zcode/shared";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";

export interface CuaOperationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

interface CuaOperationTurnTracker {
  accept(workspace: CuaOperationWorkspaceTarget, event: ZCodeComputerUseOperationEvent): void;
  /** Whether a turn currently has a Computer Use tool in progress. */
  hasActiveTurn(): boolean;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}

interface TrackerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ActiveTurnRecord extends CuaOperationState {
  workspaceKey: string;
  sessionKey: string;
  turnKey: string;
}

const MAX_RETIRED_TURN_KEYS = 2_048;
const MAX_SEEN_OPERATION_EVENT_IDS = 8_192;

function toReportedState(record: ActiveTurnRecord, active: boolean): CuaOperationState {
  return {
    active,
    sessionId: record.sessionId,
    turnId: record.turnId,
    workspacePath: record.workspacePath,
    ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
  };
}

export function createCuaOperationTurnTracker(options: {
  /** Desktop projection for the Windows top indicator; not injected on platforms other than win32. */
  reporter?: CuaOperationStateReporter;
  /** Aggregation boundary for the Windows operation indicator; PiP no longer consumes this aggregated state. */
  onTurnsActive?: () => void;
  onTurnsIdle?: () => void;
  /** macOS desktop-local PiP consumes only these product facts; panel policy remains with the producer. */
  onPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
  logger?: TrackerLogger;
}): CuaOperationTurnTracker {
  const currentTurnBySession = new Map<string, string>();
  const lastSeqBySession = new Map<string, number>();
  /**
   * Scheduled tool calls confirmed to use Computer Use (keyed by turnKey\0toolCallId).
   *
   * Only tool-scheduled includes model source (ToolCallStartedPayload has no input field), so
   * "whether this is CUA" can be determined only at scheduling time. The overlay should light up only once execution starts, though—the gap between scheduling and start may be spent waiting for
   * permission approval, when nobody is operating the computer. Store the scheduling-time fact here and apply it when tool-started arrives.
   */
  const computerUseScheduledCalls = new Set<string>();
  const activeTurns = new Map<string, ActiveTurnRecord>();
  const retiredTurnKeys = new Set<string>();
  const retiredTurnKeyOrder: string[] = [];
  const seenEventIds = new Set<string>();
  const seenEventIdOrder: string[] = [];

  const sessionKeyFor = (workspaceKey: string, sessionId: string) =>
    `${workspaceKey}\0${sessionId}`;
  const turnKeyFor = (sessionKey: string, turnId: string) => `${sessionKey}\0${turnId}`;
  const toolKeyFor = (turnKey: string, toolCallId: string) => `${turnKey}\0${toolCallId}`;

  function notifyBoundary(kind: "active" | "idle"): void {
    const callback = kind === "active" ? options.onTurnsActive : options.onTurnsIdle;
    if (!callback) return;
    options.logger?.info(
      `CUA operation turns ${kind === "active" ? "became active" : "went idle"} (activeTurns=${activeTurns.size})`,
    );
    try {
      callback();
    } catch (error) {
      // The boundary callback is a presentation side path (PiP coordination) and must not interrupt the main session event path.
      options.logger?.warn(`CUA operation turn boundary callback failed error=${String(error)}`);
    }
  }

  function publishPipLifecycle(
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ): void {
    try {
      options.onPipSessionLifecycle?.(workspace, event);
    } catch (error) {
      options.logger?.warn(
        `CUA PiP lifecycle publisher failed session=${event.sessionId} event=${event.kind} error=${String(error)}`,
      );
    }
  }

  function report(record: ActiveTurnRecord, active: boolean, refresh = false): void {
    if (options.reporter) {
      try {
        options.reporter.onStateChanged(toReportedState(record, active));
      } catch (error) {
        // Reporter is a desktop projection side path; a MessagePort close race must not interrupt the main session event path.
        options.logger?.warn(
          `CUA operation reporter failed workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId} error=${String(error)}`,
        );
      }
    }
    const message = `CUA operation turn ${active ? "activated" : "cleared"} workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId}`;
    if (refresh) {
      options.logger?.debug(message);
    } else {
      options.logger?.info(message);
    }
  }

  function retireTurn(turnKey: string): void {
    if (retiredTurnKeys.has(turnKey)) return;
    retiredTurnKeys.add(turnKey);
    retiredTurnKeyOrder.push(turnKey);
    while (retiredTurnKeyOrder.length > MAX_RETIRED_TURN_KEYS) {
      const removed = retiredTurnKeyOrder.shift();
      if (removed) retiredTurnKeys.delete(removed);
    }
  }

  function clearTurn(turnKey: string): void {
    const record = activeTurns.get(turnKey);
    if (record) {
      activeTurns.delete(turnKey);
      report(record, false);
    }
    const toolPrefix = `${turnKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(toolPrefix)) computerUseScheduledCalls.delete(key);
    }
    // The count can reach zero only after an operation turn was actually cleared; a turn that was never active does not trigger the boundary.
    if (record && activeTurns.size === 0) notifyBoundary("idle");
  }

  function clearSession(sessionKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.sessionKey === sessionKey) clearTurn(record.turnKey);
    }
    const sessionPrefix = `${sessionKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(sessionPrefix)) computerUseScheduledCalls.delete(key);
    }
  }

  function accept(
    workspace: CuaOperationWorkspaceTarget,
    event: ZCodeComputerUseOperationEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    const sessionKey = sessionKeyFor(workspaceKey, event.sessionId);
    const eventKey = `${workspaceKey}\0${event.eventId}`;
    if (seenEventIds.has(eventKey)) return;
    seenEventIds.add(eventKey);
    seenEventIdOrder.push(eventKey);
    while (seenEventIdOrder.length > MAX_SEEN_OPERATION_EVENT_IDS) {
      const removed = seenEventIdOrder.shift();
      if (removed) seenEventIds.delete(removed);
    }

    const lastSeq = lastSeqBySession.get(sessionKey) ?? 0;
    if (event.sequenceNumber < lastSeq) {
      options.logger?.debug(
        `ignored stale CUA operation event sequenceNumber=${event.sequenceNumber} lastSeq=${lastSeq} session=${event.sessionId}`,
      );
      return;
    }
    // Sideband uses the runtime's original sequenceNumber; do not mix it with projected seq values from legacy session/events,
    // or a larger raw sequence could make a later legacy terminal event appear stale and leave the overlay stuck permanently.
    lastSeqBySession.set(sessionKey, Math.max(lastSeq, event.sequenceNumber));

    if (event.kind === "turn-started") {
      if (!event.turnId) return;
      const nextTurnKey = turnKeyFor(sessionKey, event.turnId);
      if (retiredTurnKeys.has(nextTurnKey)) return;
      publishPipLifecycle(workspace, {
        kind: "turn-started",
        sessionId: event.sessionId,
        turnId: event.turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const previousTurnId = currentTurnBySession.get(sessionKey);
      if (previousTurnId && previousTurnId !== event.turnId) {
        retireTurn(turnKeyFor(sessionKey, previousTurnId));
        clearSession(sessionKey);
      }
      currentTurnBySession.set(sessionKey, event.turnId);
      return;
    }

    if (event.kind === "session-closed") {
      publishPipLifecycle(workspace, {
        kind: "session-closed",
        sessionId: event.sessionId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const currentTurnId = currentTurnBySession.get(sessionKey);
      if (currentTurnId) retireTurn(turnKeyFor(sessionKey, currentTurnId));
      clearSession(sessionKey);
      currentTurnBySession.delete(sessionKey);
      return;
    }

    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      const turnId = event.turnId;
      if (!turnId) return;
      publishPipLifecycle(workspace, {
        kind: "turn-ended",
        sessionId: event.sessionId,
        turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
        outcome: event.kind === "turn-completed" ? "completed" : "failed",
      });
      const turnKey = turnKeyFor(sessionKey, turnId);
      retireTurn(turnKey);
      clearTurn(turnKey);
      if (currentTurnBySession.get(sessionKey) === turnId) {
        currentTurnBySession.delete(sessionKey);
      }
      return;
    }

    if (event.kind !== "tool-scheduled" && event.kind !== "tool-started") return;
    const toolCallId = event.toolCallId;
    const currentTurnId = currentTurnBySession.get(sessionKey);
    const turnId = event.turnId ?? currentTurnId;
    if (!toolCallId || !turnId) return;
    // Root cause: after a new turn replaces an old one, a late tool event from the old turn must not revive the terminated top indicator.
    if (currentTurnId && turnId !== currentTurnId) return;
    if (!currentTurnId) currentTurnBySession.set(sessionKey, turnId);

    const turnKey = turnKeyFor(sessionKey, turnId);
    if (retiredTurnKeys.has(turnKey)) return;
    const toolKey = toolKeyFor(turnKey, toolCallId);
    if (event.kind === "tool-scheduled") {
      if (event.computerUse) computerUseScheduledCalls.add(toolKey);
      return;
    }

    // Check only the boolean fact "this tool call uses Computer Use"; do not parse action names:
    // action names would need to be extracted from model source and matched against a vocabulary, making the whole path fragile to SDK changes.
    // This is determined once on the bootstrap side (usesComputerUse).
    if (!computerUseScheduledCalls.delete(toolKey)) return;

    const existingRecord = activeTurns.get(turnKey);
    if (existingRecord) {
      // Each new CUA cell in the same turn must refresh the desktop overlay's safety deadline. Reporter resets the fallback timer in Main
      // without creating another native window.
      report(existingRecord, true, true);
      return;
    }

    const record: ActiveTurnRecord = {
      active: true,
      workspaceKey,
      sessionKey,
      turnKey,
      sessionId: event.sessionId,
      turnId,
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    activeTurns.set(turnKey, record);
    report(record, true);
    if (activeTurns.size === 1) notifyBoundary("active");
  }

  function clearWorkspaceKey(workspaceKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.workspaceKey === workspaceKey) clearTurn(record.turnKey);
    }
    const workspacePrefix = `${workspaceKey}\0`;
    for (const key of currentTurnBySession.keys()) {
      if (key.startsWith(workspacePrefix)) currentTurnBySession.delete(key);
    }
    for (const key of lastSeqBySession.keys()) {
      if (key.startsWith(workspacePrefix)) lastSeqBySession.delete(key);
    }
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(workspacePrefix)) computerUseScheduledCalls.delete(key);
    }
    for (let index = retiredTurnKeyOrder.length - 1; index >= 0; index -= 1) {
      const key = retiredTurnKeyOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      retiredTurnKeyOrder.splice(index, 1);
      retiredTurnKeys.delete(key);
    }
    for (let index = seenEventIdOrder.length - 1; index >= 0; index -= 1) {
      const key = seenEventIdOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      seenEventIdOrder.splice(index, 1);
      seenEventIds.delete(key);
    }
  }

  function clearAll(): void {
    for (const record of activeTurns.values()) clearTurn(record.turnKey);
    currentTurnBySession.clear();
    lastSeqBySession.clear();
    computerUseScheduledCalls.clear();
    retiredTurnKeys.clear();
    retiredTurnKeyOrder.length = 0;
    seenEventIds.clear();
    seenEventIdOrder.length = 0;
  }

  return {
    accept,
    hasActiveTurn: () => activeTurns.size > 0,
    clearWorkspaceKey,
    clearAll,
  };
}
