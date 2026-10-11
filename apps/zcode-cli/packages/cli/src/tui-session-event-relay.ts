// Persistent session-event relay for the TUI.
//
// Keep this separate so the “reattach after replacing the app” behavior can be tested
// directly. If hidden in tui-prompt-handler's closure, testing it would require a full
// set of app-factory mocks. A missed attachment fails quietly: after switching sessions,
// the TUI stops receiving out-of-turn events (dwf progress, notification-driven turns)
// while the interface appears normal.
import type { SessionEvent } from "@zcode/contracts";

/** Read the subscription function from the runtime; return undefined if unavailable (this capability is not part of the static type surface). */
type SessionEventSubscriberReader = (
  runtime: unknown,
) => ((sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void) | undefined;

interface TuiSessionEventRelay {
  /** Register a sink and return its unsubscribe function. The first sink triggers attachment. */
  addSink: (sink: (event: SessionEvent) => void) => () => void;
  /** Reattach after replacing the app: detach the old runtime, then attach to the current one. Do nothing when there are no sinks. */
  reattach: () => void;
  /** Detach the current subscription without clearing the sink registry. */
  detach: () => void;
  /** Whether a subscription is currently attached (for tests and diagnostics). */
  isAttached: () => boolean;
}

export function createTuiSessionEventRelay(input: {
  /** Read the current app's runtime on every reattachment; closure lookup rather than a passed value keeps up with replaceApp. */
  currentRuntime: () => unknown;
  readSubscriber: SessionEventSubscriberReader;
}): TuiSessionEventRelay {
  const sinks = new Set<(event: SessionEvent) => void>();
  let detachCurrent: (() => void) | undefined;

  const detach = (): void => {
    detachCurrent?.();
    detachCurrent = undefined;
  };

  const reattach = (): void => {
    detach();
    if (sinks.size === 0) return;
    const subscribe = input.readSubscriber(input.currentRuntime());
    detachCurrent = subscribe?.({
      onSessionEvent: (event) => {
        // Iterate the Set directly: JavaScript Set iteration is safe when deleting during
        // iteration (deleted, unvisited entries are skipped). A sink can therefore
        // unsubscribe in its callback without disrupting fan-out, and should not receive
        // this event again.
        for (const sink of sinks) sink(event);
      },
    });
  };

  return {
    addSink: (sink) => {
      sinks.add(sink);
      if (sinks.size === 1) reattach();
      return () => {
        sinks.delete(sink);
        if (sinks.size === 0) detach();
      };
    },
    reattach,
    detach,
    isAttached: () => detachCurrent !== undefined,
  };
}
