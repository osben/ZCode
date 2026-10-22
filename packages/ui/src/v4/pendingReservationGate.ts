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
