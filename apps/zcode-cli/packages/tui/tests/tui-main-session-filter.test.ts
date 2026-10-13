// Main session gate (WP-F, user directive 2026-08-23).
//
// Raw events from actors / child sessions are pushed via notifyExternalChildSessionEvent into **the parent runtime's same
// external sink set**, keeping the child's own sessionId. The TUI's persistent subscription and per-turn onEvent both hang off that set,
// so without filtering the actor's streaming deltas, tool calls, submit_result, and turn_complete would be painted into the main transcript.
//
// At the same time we must prove we did **not over-filter**: dwf progress is a parent-session event, and tool cards and settled completed turns must stay alive as usual.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { isMainSessionEvent } from "../src/app-session-event-handler.js";

const MAIN = "session-main";
const ACTOR = "session-actor-1";

function eventFrom(sessionId: string, type: SessionEventType = SessionEventType.AssistantMessage) {
  return { ...createSessionEvent(type, sessionId as never, {}), sessionId } as SessionEvent;
}

test("main-session events pass the gate", () => {
  assert.equal(isMainSessionEvent(eventFrom(MAIN), MAIN), true);
});

test("actor/child-session events are dropped", () => {
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), MAIN), false);
});

test("every noisy actor event kind is dropped, not just some", () => {
  // The noise the user sees is exactly these kinds: streaming deltas, tool calls (submit_result travels via tool_call_*), and turn finals.
  for (const type of [
    SessionEventType.ModelStreaming,
    SessionEventType.AssistantMessage,
    SessionEventType.ToolCallScheduled,
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
    SessionEventType.TurnStarted,
    SessionEventType.TurnComplete,
  ]) {
    assert.equal(isMainSessionEvent(eventFrom(ACTOR, type), MAIN), false, `${type} leaked`);
    assert.equal(isMainSessionEvent(eventFrom(MAIN, type), MAIN), true, `${type} wrongly dropped`);
  }
});

test("dwf progress from the parent session survives the gate (the card must keep working)", () => {
  // Progress events append to the **parent session** (session.events.ts:134). Over-filtering would turn tool cards back into dead text projections.
  const progress = eventFrom(MAIN, SessionEventType.DynamicWorkflowRunProgress);
  assert.equal(isMainSessionEvent(progress, MAIN), true);
});

test("an unknown main session id fails open rather than blanking the transcript", () => {
  // A window that cannot get the id (app not built yet) would rather render more than leave the transcript blank.
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), undefined), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), ""), true);
});

test("an event with no sessionId fails open", () => {
  const anonymous = { ...eventFrom(MAIN), sessionId: undefined } as unknown as SessionEvent;
  assert.equal(isMainSessionEvent(anonymous, MAIN), true);
});

test("the gate follows the session across a swap rather than pinning the first id", () => {
  // After /new /resume /fork the main session changed; the gate reads the id at that moment, so the new session's events pass as usual
  // while the old session's events (which may still have an in-flight tail) are judged foreign.
  const afterSwap = "session-main-2";
  assert.equal(isMainSessionEvent(eventFrom(afterSwap), afterSwap), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), afterSwap), false);
});
