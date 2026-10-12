interface TopicContinuationPorts<T> {
  readRunningRun(): Promise<string | undefined>;
  /** Must wait for the authoritative terminal state of the given run; a stop RPC returning does not mean the run has ended. */
  stopAndWait(runId: string): Promise<void>;
  /** Submits only through the existing CLI admission; never create a separate accepted queue here. */
  submit(messages: T[]): Promise<void>;
  failed(messageIds: string[], error: unknown): void | Promise<void>;
}

type Prepared<T> = { ok: true; value: T } | { ok: false; error: unknown };
interface Pending<T> {
  id: string;
  prepared: Promise<Prepared<T>>;
}

/** Coordinates only unsubmitted material; the run's authoritative state is still fetched from the CLI by the caller. */
export function createTopicContinuation<T>(ports: TopicContinuationPorts<T>) {
  let pending: Pending<T>[] = [];
  let generation = 0;
  let releaseCancellation!: () => void;
  let cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let draining: Promise<void> | undefined;
  const seen = new Set<string>();

  async function drain(): Promise<void> {
    while (pending.length) {
      const currentGeneration = generation;
      const cancelled = cancellation;
      let submitting: Pending<T>[] | undefined;
      try {
        const runId = await Promise.race([ports.readRunningRun(), cancelled.then(() => undefined)]);
        if (currentGeneration !== generation) continue;
        // The old implementation waited on attachments serially, so later inputs could not stop the run in time. Stop first, then wait for material.
        if (runId) await Promise.race([ports.stopAndWait(runId), cancelled]);
        if (currentGeneration !== generation) continue;
        let batch: Pending<T>[] = [];
        let prepared: Prepared<T>[] = [];
        do {
          batch = [...pending];
          prepared = await Promise.race([
            Promise.all(batch.map((message) => message.prepared)),
            cancelled.then(() => []),
          ]);
          if (currentGeneration !== generation) break;
          // Messages arriving while attachments are being awaited also belong to the next round; preserve arrival order, not completion order.
        } while (batch.length !== pending.length);
        if (currentGeneration !== generation) continue;
        pending.splice(0, batch.length);
        const failure = prepared.find((item) => !item.ok);
        if (failure && !failure.ok) {
          await ports.failed(
            batch.map((message) => message.id),
            failure.error,
          );
          continue;
        }
        submitting = batch;
        await ports.submit(
          prepared.map((item) => {
            if (!item.ok) throw item.error;
            return item.value;
          }),
        );
      } catch (error) {
        if (currentGeneration !== generation) continue;
        const failed = submitting ?? pending;
        if (!submitting) pending = [];
        await ports.failed(
          failed.map((message) => message.id),
          error,
        );
      }
    }
  }

  function start(): void {
    if (draining) return;
    draining = drain().finally(() => {
      draining = undefined;
      if (pending.length) start();
    });
  }

  return {
    receive(id: string, prepare: () => Promise<T>): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      const prepared = Promise.resolve()
        .then(prepare)
        .then<Prepared<T>, Prepared<T>>(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      pending.push({ id, prepared });
      start();
      return true;
    },
    cancel(): void {
      generation++;
      pending = [];
      releaseCancellation();
      cancellation = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      });
    },
    async settled(): Promise<void> {
      while (draining) await draining;
    },
  };
}
