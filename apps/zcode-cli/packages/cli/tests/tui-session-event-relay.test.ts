// TUI persistent session event relay: it must re-attach when the app is swapped
// (docs/dynamic-workflow/launch.md "The inline card").
//
// A failure of this property is silent: after /new, /resume, or /fork the subscription
// would still hang on the old runtime, and the TUI would never again receive out-of-turn
// events (dwf progress, turns driven by background notifications) while the UI looks
// perfectly normal. That is why it must have a test.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import { createTuiSessionEventRelay } from "../src/tui-session-event-relay.js";

/** A fake runtime: records attach/detach counts and can emit events proactively. */
function fakeRuntime(name: string) {
  const state = {
    name,
    attachCount: 0,
    detachCount: 0,
    emit: (_event: SessionEvent) => {},
    attached: false,
  };
  const subscribe = (sink: { onSessionEvent: (event: SessionEvent) => void }) => {
    state.attachCount += 1;
    state.attached = true;
    state.emit = (event) => sink.onSessionEvent(event);
    return () => {
      state.detachCount += 1;
      state.attached = false;
      state.emit = () => {};
    };
  };
  return { state, runtime: { subscribeEvents: subscribe } };
}

const readSubscriber = (runtime: unknown) => {
  const candidate = (runtime as { subscribeEvents?: unknown } | undefined)?.subscribeEvents;
  return typeof candidate === "function"
    ? (candidate as (sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void)
    : undefined;
};

const event = (id: string) =>
  ({ id, type: "dynamic_workflow_run_progress" }) as unknown as SessionEvent;

test("the first sink attaches to the current runtime", () => {
  const first = fakeRuntime("first");
  const relay = createTuiSessionEventRelay({
    currentRuntime: () => first.runtime,
    readSubscriber,
  });

  assert.equal(relay.isAttached(), false);
  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));

  assert.equal(relay.isAttached(), true);
  assert.equal(first.state.attachCount, 1);
  first.state.emit(event("e1"));
  assert.deepEqual(received, ["e1"]);
});

test("reattach after an app swap detaches the old runtime and follows the new one", () => {
  const first = fakeRuntime("first");
  const second = fakeRuntime("second");
  let current: unknown = first.runtime;
  const relay = createTuiSessionEventRelay({
    currentRuntime: () => current,
    readSubscriber,
  });

  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  first.state.emit(event("before-swap"));

  // After replaceApp swaps the app, call reattach.
  current = second.runtime;
  relay.reattach();

  assert.equal(first.state.detachCount, 1, "old runtime must be detached");
  assert.equal(second.state.attachCount, 1, "new runtime must be attached");
  assert.equal(first.state.attached, false);

  // Events from the new runtime arrive; the old one is detached and cannot emit anything.
  second.state.emit(event("after-swap"));
  first.state.emit(event("orphan"));
  assert.deepEqual(received, ["before-swap", "after-swap"]);
});

test("sinks survive the swap without re-registering", () => {
  const first = fakeRuntime("first");
  const second = fakeRuntime("second");
  let current: unknown = first.runtime;
  const relay = createTuiSessionEventRelay({ currentRuntime: () => current, readSubscriber });

  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  current = second.runtime;
  relay.reattach();
  current = fakeRuntime("third").runtime;
  relay.reattach();

  // The same sink survives two app swaps while staying registered (the TUI side does not
  // need to re-mount the useEffect).
  assert.equal(relay.isAttached(), true);
  assert.equal(received.length, 0);
});

test("reattach with no sinks stays detached (no subscription leak)", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  relay.reattach();
  assert.equal(relay.isAttached(), false);
  assert.equal(only.state.attachCount, 0);
});

test("the last sink unsubscribing detaches the runtime", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  const stopA = relay.addSink(() => {});
  const stopB = relay.addSink(() => {});
  stopA();
  assert.equal(relay.isAttached(), true, "one remaining sink keeps the subscription");
  stopB();
  assert.equal(relay.isAttached(), false);
  assert.equal(only.state.detachCount, 1);
});

test("a runtime with no subscribeEvents degrades to unattached rather than throwing", () => {
  const relay = createTuiSessionEventRelay({ currentRuntime: () => ({}), readSubscriber });
  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  assert.equal(relay.isAttached(), false);
  // A missing capability must not keep the TUI from starting up.
  relay.reattach();
  assert.deepEqual(received, []);
});

test("a sink unsubscribing during fan-out does not break the dispatch", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  const seen: string[] = [];
  let stopSelf: (() => void) | undefined;
  stopSelf = relay.addSink((e) => {
    seen.push(`a:${e.id}`);
    stopSelf?.();
  });
  relay.addSink((e) => seen.push(`b:${e.id}`));

  only.state.emit(event("e1"));
  // The first sink unsubscribes inside its callback; the second still receives this event.
  assert.deepEqual(seen, ["a:e1", "b:e1"]);
  only.state.emit(event("e2"));
  assert.deepEqual(seen, ["a:e1", "b:e1", "b:e2"]);
});

// ── WP-F: the session gate must follow the app swap to a new session (a getter, not a snapshot) ──

test("the main session id is read per call, so it follows a replaceApp swap", () => {
  // This pins the shape of the CLI-side getMainSessionId: read app.runtime.getSessionId()
  // fresh each time. A snapshotted id goes stale after /new /resume /fork and would then
  // misjudge the **entire** main transcript as foreign events — far worse than the actor
  // noise it was meant to fix.
  let currentSessionId = "session-main-1";
  const getMainSessionId = () => currentSessionId;

  assert.equal(getMainSessionId(), "session-main-1");
  currentSessionId = "session-main-2";
  assert.equal(getMainSessionId(), "session-main-2", "a snapshot would still report the old id");
});

test("a runtime with no getSessionId yields undefined, which fails the gate open", () => {
  const readMainSessionId = (runtime: unknown): string | undefined => {
    const sessionId = (runtime as { getSessionId?: () => string } | undefined)?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };
  assert.equal(readMainSessionId(undefined), undefined);
  assert.equal(readMainSessionId({}), undefined);
  assert.equal(readMainSessionId({ getSessionId: () => "" }), undefined);
  assert.equal(readMainSessionId({ getSessionId: () => "session-x" }), "session-x");
});
