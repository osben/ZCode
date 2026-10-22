/**
 * Session ids whose `createSession` command has been sent but not yet acknowledged.
 *
 * A first message binds the pane to the reserved session id before the host acknowledges the create.
 * A subscribe for that id sent in this window reaches the host before the create has persisted the
 * session, and the host answers "not found", which the projection store treats as terminal. The pane
 * therefore opens the conversation lease only after `whenSettled` resolves, which is the same ordering
 * as every later turn (the subscribe follows the acknowledgement).
 */
export class PendingReservationGate {
  readonly #pending = new Map<string, Set<Promise<void>>>();

  /** Marks a create for `sessionId` as in flight; the returned function settles it (safe to call twice). */
  begin(sessionId: string): () => void {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const set = this.#pending.get(sessionId) ?? new Set<Promise<void>>();
    set.add(done);
    this.#pending.set(sessionId, set);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      resolveDone();
      set.delete(done);
      if (set.size === 0 && this.#pending.get(sessionId) === set) this.#pending.delete(sessionId);
    };
  }

  isPending(sessionId: string): boolean {
    return this.#pending.has(sessionId);
  }

  /** Resolves once every create in flight for `sessionId` has settled; resolves at once when none is. */
  whenSettled(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId);
    return pending ? Promise.all(pending).then(() => undefined) : Promise.resolve();
  }
}

/**
 * Wraps a command dispatch so a `createSession` for a reserved id is marked from the first synchronous
 * statement until its dispatch settles (on success, failure or early refusal). The mark must exist before
 * any `await`, because a lease effect can run in that window and subscribe to the reserved id.
 */
export function trackReservedCreate<A extends readonly unknown[], R>(
  gate: PendingReservationGate,
  dispatch: (...args: A) => Promise<R>,
  reservedSessionIdOf: (args: A) => string | null,
): (...args: A) => Promise<R> {
  return (...args: A) => {
    const sessionId = reservedSessionIdOf(args);
    const settle = sessionId === null ? null : gate.begin(sessionId);
    return dispatch(...args).finally(() => settle?.());
  };
}

/**
 * The reserved session id of a dispatched `createSession`, or null for every other command. A reservation
 * carries its id in the payload and dispatches with a null target (SessionPane's first-submission create),
 * so the payload is read first; a create dispatched with a target uses that target.
 */
export function reservedCreateSessionId(args: readonly unknown[]): string | null {
  if (args[0] !== "createSession") return null;
  const payload = args[1];
  if (payload !== null && typeof payload === "object") {
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  const target = args[2];
  return typeof target === "string" && target.length > 0 ? target : null;
}
