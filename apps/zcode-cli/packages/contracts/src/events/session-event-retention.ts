import type { SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * Transient events that stream alongside messages.
 * The event store still assigns their sequence numbers and sends them to the live sink, but
 * they can be evicted from memory after a turn ends and is replaced by the next turn:
 * completed-turn text is reconstructed from persisted messages, and reducer / rewind / fork /
 * checkpoint do not consume these event types.
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * Time-based fallback for sealed turns without a successor.
 * A subagent child session has only one turn and never receives another turn_started. In a
 * real session, one child session retained about 10,000 deltas until its record was evicted
 * from the pool. The 60s sampling tick calls `collectExpired` to evict sealed turns past the
 * grace period.
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

/**
 * Reduce metadata in the resident copy of `model_request` when evicting a sealed turn (see the spec's
 * “model_request metadata reduction” section). Root cause: `messages` contains the full context for
 * every model request, one entry per tool iteration, and remains resident indefinitely. Compaction
 * truncates only later requests; it does not reclaim stored events. Long sessions showed event-store
 * memory growing linearly with turns, by about 150 MB. In-memory store readers use only
 * `messages.length`, while the live sink (debug JSONL) receives the complete object returned by append.
 * Therefore, replace only the resident copy with `messageCount`; keep the event ID, seq, and all other
 * payload fields unchanged.
 */
export function slimRetainedModelRequest(event: SessionEvent): SessionEvent {
  if (event.type !== SessionEventType.ModelRequest) {
    return event;
  }
  const payload = event.payload as { messages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.messages)) {
    return event;
  }
  const { messages, ...metadata } = payload;
  return { ...event, payload: { ...metadata, messageCount: messages.length } } as SessionEvent;
}

export type SessionEventRetentionMode = "unbounded" | "turn-window";

export interface SessionEventRetentionPolicy {
  /**
   * Called after each append. Returns the turnIds whose transient events should be evicted
   * from memory; an empty array means nothing should be evicted. The strategy uses only the
   * event sequence and does not depend on persistence results.
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * Time-based fallback: returns sealed turnIds that ended before `nowMs - graceMs` and still
   * have no successor turn, and removes them from the pending-eviction set. Called by a
   * low-frequency tick.
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * Turn-window strategy: `turn_complete` / `turn_error` only mark a turn as ended (sealed).
 * Evict transient events for all sealed turns together when the next `turn_started` arrives
 * (one-turn delay). The delay is needed because messages may not yet be persisted when a turn
 * ends, and cold recovery still relies on transient in-memory events to reconstruct text.
 * Starting the next turn means the user sent another message, so the previous turn must have
 * been persisted.
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
  };
}

export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
