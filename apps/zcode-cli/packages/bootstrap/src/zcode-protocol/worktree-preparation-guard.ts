import { AsyncLocalStorage } from "node:async_hooks";

/** The durable attempt is the compare-and-set boundary for all preparation mutations. */
export function assertWorktreePreparationMutation(
  current: { attemptId?: string; status: string },
  input: {
    expectedAttemptId?: string;
    status: string;
    worktreePreparation?: { attemptId?: string };
  },
): void {
  if (
    current.status === "active" ||
    (current.attemptId && current.attemptId !== input.expectedAttemptId)
  ) {
    throw new Error("guard.worktreePreparationStale");
  }
  if (
    current.status === "cancelled" &&
    !(
      input.status === "preparing" &&
      input.worktreePreparation?.attemptId &&
      input.worktreePreparation.attemptId !== current.attemptId
    )
  ) {
    throw new Error("guard.worktreePreparationCancelled");
  }
}
const mutationTails = new WeakMap<object, Map<string, Promise<void>>>();

// Re-entrancy scope: a whole prepared-session activation (record materialization → config →
// first-input admission → completion) holds the same per-session lock, while the hooks it calls
// (createSessionRecord, completePreparedWorktreeActivation) serialize their own sections through
// this helper again. The store identifies that already-held lock without deadlocking.
const activeMutation = new AsyncLocalStorage<{ owner: object; sessionId: string }>();

/**
 * Keep the read/check/persist boundary atomic across overlapping gateway commands. Re-entrant for
 * the same (owner, sessionId): a nested section runs inline inside the already-held lock.
 */
export async function serializePreparedWorktreeMutation<T>(
  owner: object,
  sessionId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sessionId) return operation();
  const active = activeMutation.getStore();
  if (active && active.owner === owner && active.sessionId === sessionId) {
    return operation();
  }
  let tails = mutationTails.get(owner);
  if (!tails) {
    tails = new Map();
    mutationTails.set(owner, tails);
  }
  const previous = tails.get(sessionId) ?? Promise.resolve();
  const pending = previous.then(() => activeMutation.run({ owner, sessionId }, operation));
  const tail = pending.then(
    () => {},
    () => {},
  );
  tails.set(sessionId, tail);
  try {
    return await pending;
  } finally {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  }
}
