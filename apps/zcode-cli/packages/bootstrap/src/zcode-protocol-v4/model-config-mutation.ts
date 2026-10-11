import type { ZCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<ZCodeApp, Promise<void>>();

/**
 * Model configuration for a session App has a single serialized critical section.
 *
 * Provider registry fallback and user `switchModelConfig` used to call `setModel` directly. Their
 * async chains could interleave so a later catalog fallback overwrote the user's choice, and event
 * order could diverge from the runtime's final value. Serialize every model/thought change by App
 * identity here. A failure ends only the current operation and does not poison the later tail. The
 * WeakMap does not extend the session lifetime.
 */
export async function runSessionModelConfigMutation<T>(
  app: ZCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}
