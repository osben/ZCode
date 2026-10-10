interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

/**
 * Ordering barrier between configuration commands and send commands.
 *
 * Mode/model selection optimistically updates the UI, then submits CAS asynchronously. If the user sends immediately afterward,
 * sendText may run before CAS retries complete, so the UI shows the new config while Runtime still uses the old one.
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}
