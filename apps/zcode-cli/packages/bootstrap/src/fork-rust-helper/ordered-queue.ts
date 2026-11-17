/**
 * Runs queued tasks one after another, each starting only once the previous one settled. A rejected task does not stop
 * the queue: its own promise rejects, and the next task runs. The helper uses it so that two app-tool replaces of one
 * session reach Rust in the order they were made: Rust serves each request in its own task, so two in flight could
 * apply out of order.
 */
export function createOrderedQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
