/**
 * createSession commands received but not yet settled, keyed by the reserved session id.
 *
 * The renderer subscribes as soon as it reserves a session id, so a subscribe can reach the gateway
 * while the create is still admitted or executing. The gateway waits on `whenSettled` before it answers
 * "not found" (specs/acp-agent-runtime.md "S6" and the session-reservation notes).
 */
export class PendingSessionCreations {
  readonly #pending = new Map<string, Set<Promise<void>>>();

  /** Registers a create for `sessionId`; the returned function settles it (idempotent per call). */
  begin(sessionId: string): () => void {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const set = this.#pending.get(sessionId) ?? new Set<Promise<void>>();
    set.add(done);
    this.#pending.set(sessionId, set);
    return () => {
      resolveDone();
      set.delete(done);
      if (set.size === 0 && this.#pending.get(sessionId) === set) {
        this.#pending.delete(sessionId);
      }
    };
  }

  /** Resolves once every create received so far for `sessionId` has settled. */
  whenSettled(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId);
    return pending ? Promise.all(pending).then(() => undefined) : Promise.resolve();
  }
}
