/**
 * One lane per helper session: its opens and closes run one at a time, in arrival order (spec F3
 * "Session open and close"). A failed step does not stop the steps after it.
 */
export class SessionLanes {
  private readonly lanes = new Map<string, Promise<void>>();

  /** Runs `work` after every earlier step of `sessionId`. */
  run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(sessionId, tail);
    void tail.then(() => {
      if (this.lanes.get(sessionId) === tail) this.lanes.delete(sessionId);
    });
    return run;
  }
}
