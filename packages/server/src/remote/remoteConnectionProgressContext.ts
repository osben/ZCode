import { AsyncLocalStorage } from "node:async_hooks";

export type RemoteConnectionProgressLevel = "info" | "warn" | "error";

export interface RemoteConnectionProgressEvent {
  requestId: string;
  level: RemoteConnectionProgressLevel;
  args: unknown[];
}

interface RemoteConnectionProgressStore {
  requestId: string;
  active: boolean;
}

/**
 * Associate concurrent remote-connection logs in the shared Host with their respective requestId.
 *
 * After remote connections were moved into the window-scoped Host, the process label no longer identifies a specific remote connection,
 * and Main cannot tell from shared stdout which connection owns a log. AsyncLocalStorage preserves the asynchronous call-chain context
 * and reporting stops after the connection Promise settles, preventing late logs from long-lived streams from polluting the connection panel.
 */
export function createRemoteConnectionProgressContext(options: {
  emit: (event: RemoteConnectionProgressEvent) => void;
}) {
  const storage = new AsyncLocalStorage<RemoteConnectionProgressStore>();

  return {
    async run<T>(requestId: string, task: () => Promise<T>): Promise<T> {
      const store: RemoteConnectionProgressStore = { requestId, active: true };
      return storage.run(store, async () => {
        try {
          return await task();
        } finally {
          store.active = false;
        }
      });
    },

    report(level: RemoteConnectionProgressLevel, args: unknown[]): void {
      const store = storage.getStore();
      if (!store?.active) {
        return;
      }
      options.emit({ requestId: store.requestId, level, args });
    },
  };
}
