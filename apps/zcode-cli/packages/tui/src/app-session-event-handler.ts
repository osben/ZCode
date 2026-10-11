import type { SessionEvent } from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { applySessionEventToState } from "./app-events.js";
import { describeSessionEvent } from "./state.js";
import { isSubagentToolMirror } from "./app-subagent-events.js";

type SessionEventHandlers = Parameters<typeof applySessionEventToState>[1];

/**
 * Bounded memory window for IDs of applied events.
 *
 * Why this is needed: the cross-turn persistent subscription and per-turn `onEvent` can both deliver the same event.
 * The mirror is immune to duplicate delivery (the shared reducer returns null for an event it just reduced), but the transcript is not:
 * events such as `assistant_message` are appended unconditionally, so duplicate delivery shows the reply twice.
 *
 * A bounded window is enough: the two sinks fire sequentially on the same emit, so duplicates are always adjacent and there is no need to remember the entire session.
 */
const MAX_REMEMBERED_EVENT_IDS = 2_048;

/**
 * Allow only **main-session** events into the transcript.
 *
 * Why filtering is required: raw actor/subsession events are delivered through `notifyExternalChildSessionEvent` into
 * **the same external sink set as the parent runtime**, while **retaining the child's sessionId** (the protocol uses it to route the event
 * to the desktop as a detached live session). The TUI sink is attached to that set, as is per-turn onEvent,
 * so without filtering, actor streaming deltas, tool calls, submit_result, and turn_complete would all appear in the main transcript.
 *
 * DWF progress events are **parent-session** events (`session.events.ts:134`, "append to parent session"), so tool cards
 * and settled completion turns are unaffected; they remain the only two workflow surfaces in the TUI.
 *
 * Allow events when the main sessionId is unavailable: rendering a little extra is preferable to blanking the entire transcript because an ID is missing.
 */
export function isMainSessionEvent(
  event: SessionEvent,
  mainSessionId: string | undefined,
): boolean {
  // Tool mirrors deliberately carry the parent's sessionId. They are activity
  // metadata, not parent transcript/tool/usage facts.
  if (isSubagentToolMirror(event)) return false;
  if (!mainSessionId) return true;
  const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  if (eventSessionId === undefined) return true;
  return eventSessionId === mainSessionId;
}

type SessionEventApplierInput = SessionEventHandlers & {
  subscribeSessionEvents?: (sink: (event: SessionEvent) => void) => () => void;
  observeSessionEvent?: (event: SessionEvent) => void;
  copy: TuiCopy;
  getMainSessionId?: () => string | undefined;
  setLastEvent: (event: string) => void;
};

/**
 * Complete entry pipeline: session gate → deduplication → apply to state.
 *
 * Export this as a pure function (the caller owns the seen set) instead of keeping it in the hook so the **effect** can be tested:
 * a regression such as "an actor's turn_complete is not appended to the main transcript by the fallback" can only be proven at the pipeline level,
 * not by testing the predicate alone. Return whether the event was actually applied.
 *
 * Run the gate before deduplication: foreign events must not consume slots in the bounded deduplication window
 * (actor events could otherwise evict a main-session duplicate and let it through).
 */
export function applyMainSessionEvent(
  event: SessionEvent,
  applied: Set<string>,
  input: SessionEventApplierInput,
): boolean {
  if (!isMainSessionEvent(event, input.getMainSessionId?.())) return false;
  if (!rememberSessionEvent(applied, event)) return false;
  input.setLastEvent(describeSessionEvent(event));
  applySessionEventToState(event, input, input.copy);
  return true;
}

export function useSessionEventApplier(
  input: SessionEventApplierInput,
): (event: SessionEvent) => void {
  const appliedEventIdsRef = React.useRef<Set<string>>(new Set());
  const applyEvent = React.useCallback(
    (event: SessionEvent) => {
      input.observeSessionEvent?.(event);
      applyMainSessionEvent(event, appliedEventIdsRef.current, input);
    },
    [input],
  );
  useSessionEventSubscription(input.subscribeSessionEvents, applyEvent);
  return applyEvent;
}

/** A stable subscription survives renders; both event sources share the applier. */
export function useSessionEventSubscription(
  subscribe: ((sink: (event: SessionEvent) => void) => () => void) | undefined,
  applyEvent: (event: SessionEvent) => void,
): void {
  const latest = React.useRef(applyEvent);
  latest.current = applyEvent;
  React.useEffect(() => subscribe?.((event) => latest.current(event)), [subscribe]);
}

/**
 * Record this event; return false if it has already been applied (the caller should skip it entirely).
 *
 * Always allow events without IDs: an occasional duplicate render is preferable to dropping an event because a key is missing.
 */
export function rememberSessionEvent(applied: Set<string>, event: SessionEvent): boolean {
  const eventId = typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
  if (eventId === undefined) return true;
  if (applied.has(eventId)) return false;
  applied.add(eventId);
  if (applied.size > MAX_REMEMBERED_EVENT_IDS) {
    // Set preserves insertion order, so the oldest entries are removed first.
    const excess = applied.size - MAX_REMEMBERED_EVENT_IDS;
    let removed = 0;
    for (const id of applied) {
      applied.delete(id);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  return true;
}
