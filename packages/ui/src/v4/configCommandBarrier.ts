export interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

export const CONFIG_COMMAND_SUPERSEDED = Symbol("config-command-superseded");

export interface LatestConfigCommandScheduler<T> {
  /**
   * Merge equivalent config commands that have not started; calls replaced by a newer intent resolve as superseded.
   */
  schedule(command: () => Promise<T>): Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>;
  /**
   * Seal the current wait slot. Call before enqueueing a send command so the sealed config is
   * guaranteed to run before the send; later config changes create a new slot after the send.
   */
  seal(): void;
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

/**
 * Merge equivalent config commands that have not started behind the same ordering barrier.
 *
 * Root cause: rapidly clicking model/reasoning options queued every intermediate value in the
 * stdio CAS queue. Even after the UI reached its final selection, the runtime still processed each
 * stale intent. Replace only slots that have not started; do not cancel commands already sent.
 * Sealing before sending preserves the user's config → send ordering.
 */
export function createLatestConfigCommandScheduler<T>(
  barrier: ConfigCommandBarrier,
): LatestConfigCommandScheduler<T> {
  interface Waiter {
    reject: (reason?: unknown) => void;
    resolve: (value: T | typeof CONFIG_COMMAND_SUPERSEDED) => void;
  }
  interface Slot {
    command: () => Promise<T>;
    waiter: Waiter;
  }

  let replaceableSlot: Slot | null = null;

  return {
    schedule(command) {
      return new Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>((resolve, reject) => {
        if (replaceableSlot) {
          replaceableSlot.waiter.resolve(CONFIG_COMMAND_SUPERSEDED);
          replaceableSlot.command = command;
          replaceableSlot.waiter = { reject, resolve };
          return;
        }

        const slot: Slot = {
          command,
          waiter: { reject, resolve },
        };
        replaceableSlot = slot;
        void barrier.enqueue(async () => {
          if (replaceableSlot === slot) {
            replaceableSlot = null;
          }
          const scheduledCommand = slot.command;
          const scheduledWaiter = slot.waiter;
          try {
            scheduledWaiter.resolve(await scheduledCommand());
          } catch (error) {
            scheduledWaiter.reject(error);
          }
        });
      });
    },
    seal() {
      replaceableSlot = null;
    },
  };
}
